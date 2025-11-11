const { SupportRequest } = require('../models/SupportRequest');
const { SupportSession } = require('../models/SupportSession');
const { SupportMessage, validateSupportMessage } = require('../models/SupportMessage');
const { CannedResponse, validateCannedResponse } = require('../models/CannedResponse');
const { broadcastMessage, notifySupportStaff } = require('../services/supportService');
const { User } = require('../models/user');
const mongoose = require('mongoose');

async function createSupportRequest(req, res) {
  const { user_id, subject, description, initial_message } = req.body;

  if (!mongoose.Types.ObjectId.isValid(user_id)) {
    console.log('Invalid user_id:', user_id);
    return res.status(400).send('Invalid user_id format');
  }

  const userExists = await User.findById(user_id);
  if (!userExists) {
    console.log('User not found for ID:', user_id);
    return res.status(404).send('User not found');
  }

  // التحقق من عدد الطلبات المفتوحة للمستخدم
  const openRequestsCount = await SupportRequest.countDocuments({
    user_id,
    status: 'Open',
  });
  if (openRequestsCount >= 3) {
    console.log(`User ${user_id} has reached the limit of 3 open support requests`);
    return res.status(400).send('You have reached the maximum limit of 3 open support requests. Please wait until one is resolved.');
  }

  const supportRequest = new SupportRequest({
    user_id,
    subject,
    description,
    initial_message,
    status: 'Open',
  });

  try {
    await supportRequest.save();
    console.log('Support request saved:', supportRequest._id);
    notifySupportStaff(supportRequest).catch((err) => console.error('Failed to notify staff:', err));
    res.status(201).send({
      supportRequest,
      auto_reply: 'Hi, you can leave your problem and an online agent will be here soon',
    });
  } catch (err) {
    console.error('Error saving support request:', err);
    res.status(500).send(`Error creating support request: ${err.message}`);
  }
}
async function createSupportSession(req, res, io) {
  console.log('Received request body:', req.body);
  console.log('IO instance:', io); // تحقق من أن io مُمرر بشكل صحيح

  const { support_request_id, support_staff_id } = req.body;

  const supportRequest = await SupportRequest.findById(support_request_id);
  if (!supportRequest) return res.status(404).send('Support request not found');
  console.log('Support request:', supportRequest);
  if (supportRequest.status !== 'Open') {
    console.log('Status check failed. Current status:', supportRequest.status);
    return res.status(400).send('Support request is not open');
  }

  const session = new SupportSession({
    support_request_id,
    user_id: supportRequest.user_id,
    support_staff_id,
    status: 'Active',
  });

  try {
    await session.save();
    supportRequest.status = 'Accepted';
    await supportRequest.save();
    io.emit('session_started', { session_id: session._id, user_id: supportRequest.user_id, support_staff_id });
    res.status(201).send(session);
  } catch (err) {
    res.status(500).send(`Error creating support session: ${err.message}`);
  }
}
async function sendSupportMessage(req, res) {
  
  console.log('Request body:', req.body);
  const { error } = validateSupportMessage(req.body);
  if (error) {
    console.log('Validation error:', error.details);
    return res.status(400).send(error.details[0].message);
  }
  const { support_session_id, sender_id, message, canned_response_id } = req.body;

  const session = await SupportSession.findById(support_session_id);
  if (!session) return res.status(404).send('Support session not found');
  if (session.status !== 'Active') return res.status(400).send('Support session is not active');
  if (![session.user_id.toString(), session.support_staff_id.toString()].includes(sender_id)) {
    return res.status(403).send('Sender is not part of this session');
  }

  let finalMessage = message;
  let isCanned = false;
  if (canned_response_id !== null) {
    const cannedResponse = await CannedResponse.findById(canned_response_id);
    if (!cannedResponse) return res.status(404).send('Canned response not found');
    finalMessage = cannedResponse.message;
    isCanned = true;
  }

  const supportMessage = new SupportMessage({
    support_session_id,
    sender_id,
    message: finalMessage,
    is_canned: isCanned,
  });

  try {
    await supportMessage.save();
    await broadcastMessage(support_session_id, finalMessage, sender_id, isCanned);
    res.status(201).send(supportMessage);
  } catch (err) {
    res.status(500).send(`Error sending message: ${err.message}`);
  }
}
async function closeSupportSession(req, res) {
  const { session_id } = req.params;
  const { rating } = req.body;

  const session = await SupportSession.findById(session_id);
  if (!session) return res.status(404).send('Support session not found');
  if (session.status !== 'Active') return res.status(400).send('Support session is already closed');

  try {
    session.status = 'Closed';
    if (rating && rating >= 1 && rating <= 5) session.rating = rating;
    await session.save();

    const supportRequest = await SupportRequest.findById(session.support_request_id);
    supportRequest.status = 'Resolved';
    await supportRequest.save();

    res.status(200).send(session);
  } catch (err) {
    res.status(500).send(`Error closing session: ${err.message}`);
  }
}

async function getSupportRequests(req, res) {
  const { user_id } = req.params;
  try {
    const requests = await SupportRequest.find({ user_id });
    res.status(200).send(requests);
  } catch (err) {
    res.status(500).send(`Error fetching support requests: ${err.message}`);
  }
}

async function getPendingSupportRequests(req, res) {
  try {
    const requests = await SupportRequest.find({ status: 'Open' }).populate('user_id', 'username'); // جلب اسم المستخدم
    res.status(200).send(requests);
  } catch (err) {
    res.status(500).send(`Error fetching pending support requests: ${err.message}`);
  }
}

async function getSupportMessages(req, res) {
  const { session_id } = req.params;
  try {
    const messages = await SupportMessage.find({ support_session_id: session_id })
      .populate('sender_id', 'username') 
      .sort({ created_at: 1 }); 
    res.status(200).send(messages);
  } catch (err) {
    res.status(500).send(`Error fetching messages: ${err.message}`);
  }
}
async function createCannedResponse(req, res) {
  const { error } = validateCannedResponse(req.body);
  if (error) return res.status(400).send(error.details[0].message);

  const { title, message, created_by } = req.body;

  const cannedResponse = new CannedResponse({
    title,
    message,
    created_by,
  });

  try {
    await cannedResponse.save();
    res.status(201).send(cannedResponse);
  } catch (err) {
    res.status(500).send(`Error creating canned response: ${err.message}`);
  }
}

async function getCannedResponses(req, res) {
  try {
    const responses = await CannedResponse.find();
    res.status(200).send(responses);
  } catch (err) {
    res.status(500).send(`Error fetching canned responses: ${err.message}`);
  }
}

// إضافة getSupportSessions لدعم fetchSupportSessions في العميل
async function getSupportSessions(req, res) {
  const { user_id } = req.params;
  try {
    const sessions = await SupportSession.find({
      $or: [{ user_id }, { support_staff_id: user_id }],
      status: 'Active',
    })
      .populate({
        path: 'support_request_id',
        populate: { path: 'user_id', select: 'username' }, // جلب username من User
      });
    res.status(200).send(sessions);
  } catch (err) {
    res.status(500).send(`Error fetching support sessions: ${err.message}`);
  }
}



async function deleteSupportSession(req, res) {
  const { session_id } = req.params;
  const ender_id = req.body.ender_id || req.user?._id;

  console.log(`Attempting to delete session with ID: ${session_id}, ended by: ${ender_id}`);

  if (!mongoose.Types.ObjectId.isValid(session_id)) {
    console.log(`Invalid session_id format: ${session_id}`);
    return res.status(400).send('Invalid session ID format');
  }

  try {
    const session = await SupportSession.findById(session_id);
    if (!session) {
      console.log(`Session not found for ID: ${session_id}`);
      return res.status(404).send('Support session not found');
    }

    // حفظ معرفات المستلمين قبل الحذف
    const recipients = {
      user_id: session.user_id.toString(),
      support_staff_id: session.support_staff_id.toString(),
    };

    // حذف الجلسة
    await SupportSession.deleteOne({ _id: session_id });
    // حذف الرسائل المرتبطة
    await SupportMessage.deleteMany({ support_session_id: session_id });
    // حذف طلب الدعم المرتبط
    const supportRequest = await SupportRequest.findById(session.support_request_id);
    if (supportRequest) {
      await SupportRequest.deleteOne({ _id: session.support_request_id });
    }

    // إرسال إشعار مع المستلمين المحفوظين
    const message = ender_id === recipients.support_staff_id 
      ? 'The session has been ended by support' 
      : 'The session has been ended by the user';
    await broadcastMessage(session_id, message, 'system', false, ender_id, recipients);

    console.log(`Session ${session_id} deleted successfully`);
    res.status(200).send({ message: 'Session and related request deleted successfully', sessionId: session_id });
  } catch (err) {
    console.error(`Error deleting support session ${session_id}:`, err);
    res.status(500).send(`Error deleting support session: ${err.message}`);
  }
}



module.exports = {
  createSupportRequest,
  createSupportSession,
  sendSupportMessage,
  closeSupportSession,
  getSupportRequests,
  getPendingSupportRequests,
  getSupportMessages,
  createCannedResponse,
  getCannedResponses,
  getSupportSessions, // أضفت هذا
  deleteSupportSession
};