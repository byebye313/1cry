const clients = new Map();
const { SupportSession } = require('../models/SupportSession');
const { SupportMessage } = require('../models/SupportMessage');

function initializeSupportWebSocket(server, io) {
  io.on('connection', (socket) => {
    console.log('اتصال WebSocket جديد:', socket.id);

    socket.on('join', ({ user_id }) => {
      clients.set(user_id, socket);
      socket.emit('status', { status: 'connected' });
      console.log(`the user :  ${user_id} connected`);
    });

    socket.on('message', ({ support_session_id, message, sender_id, is_canned }) => {
      broadcastMessage(support_session_id, message, sender_id, is_canned || false);
    });

    socket.on('disconnect', () => {
      for (const [user_id, s] of clients) {
        if (s === socket) {
          clients.delete(user_id);
          console.log(`The user  ${user_id} disconnected `);
          break;
        }
      }
    });
  });
}

async function broadcastMessage(support_session_id, message, sender_id, is_canned = false, ender_id = null, predefinedRecipients = null) {
  let recipients = [];
  
  if (predefinedRecipients) {
    recipients = [predefinedRecipients.user_id, predefinedRecipients.support_staff_id];
  } else {
    const session = await SupportSession.findById(support_session_id);
    if (session) {
      recipients = [session.user_id.toString(), session.support_staff_id.toString()];
    } else {
      const messages = await SupportMessage.find({ support_session_id });
      if (messages.length > 0) {
        recipients = [...new Set(messages.map(msg => msg.sender_id.toString()))];
      }
    }
  }

  console.log(`Broadcasting message to recipients: ${recipients}`);

  for (const [user_id, socket] of clients) {
    if (recipients.includes(user_id)) {
      console.log(`Sending to user ${user_id}: ${message}`);
      socket.emit('message', {
        sender_id,
        message,
        support_session_id,
        is_canned,
        timestamp: new Date().toISOString(),
      });

      // إرسال إشعار جديد للمستخدم إذا كانت الرسالة من موظف الدعم
      const session = predefinedRecipients ? predefinedRecipients : await SupportSession.findById(support_session_id);
      if (sender_id !== 'system' && sender_id === session?.support_staff_id?.toString() && user_id === session?.user_id?.toString()) {
        console.log(`Sending new_support_message to user ${user_id}: ${message}`);
        socket.emit('new_support_message', {
          support_session_id,
          message,
          sender_id,
          timestamp: new Date().toISOString(),
        });
      }

      if (sender_id === 'system' && (message === 'The session has been ended by support' || message === 'The session has been ended by the user')) {
        socket.emit('session_ended', {
          support_session_id,
          message,
          ender_id,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}

async function notifySupportStaff(support_request) {
  const { User } = require('../models/User');
  for (const [user_id, socket] of clients) {
    const user = await User.findById(user_id);
    if (user && user.role === 'Support') {
      socket.emit('new_support_request', {
        type: 'new_support_request',
        support_request_id: support_request._id,
        user_id: support_request.user_id,
        initial_message: support_request.initial_message,
        timestamp: new Date().toISOString(),
      });
      console.log(`تم إرسال إشعار إلى الموظف ${user_id}`);
    }
  }
}

module.exports = { initializeSupportWebSocket, broadcastMessage, notifySupportStaff };