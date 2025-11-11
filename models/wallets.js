const mongoose = require('mongoose');

// Define the Network schema
const networkSchema = new mongoose.Schema({
    name: String,
    address: String,
});

// Define the Coin schema
const coinSchema = new mongoose.Schema({
    name: String,
    networks: [networkSchema],
});

// Define the Wallet schema
const walletSchema = new mongoose.Schema({
    name: String,
    coins: [coinSchema],
    User: {
        type:mongoose.Types.ObjectId,
        ref:"User"
    }
});

// Create models
const Wallet = mongoose.model('Wallet', walletSchema);

module.exports = Wallet;
