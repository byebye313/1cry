const mongoose = require('mongoose');
const { AITrade, validateAITrade } = require('./models/AI_Trade');
const trades = require('./seedTrades');

async function seedDatabase() {
  try {
    // Connect to MongoDB
    await mongoose.connect('mongodb://localhost:27017/trading_platform', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Validate each trade before insertion
    for (const trade of trades) {
      const { error } = validateAITrade({
        ...trade,
        user_id: trade.user_id.toString(),
        ai_wallet_id: trade.ai_wallet_id.toString(),
        created_at: trade.created_at.toISOString(),
        updated_at: trade.updated_at.toISOString(),
      });
      if (error) {
        throw new Error(`Validation error for trade at ${trade.created_at}: ${error.details[0].message}`);
      }
    }

    // Optionally clear the existing AITrade collection
    await AITrade.deleteMany({});
    console.log('Cleared existing trades in AITrade collection');

    // Insert the trades
    const result = await AITrade.insertMany(trades, { ordered: false });
    console.log(`Successfully seeded ${result.length} trades`);

  } catch (error) {
    console.error('Error seeding database:', error.message);

    // Handle duplicate key errors (e.g., if trades already exist)
    if (error.code === 11000) {
      console.error('Duplicate key error. Some trades may already exist in the database.');
    }
  } finally {
    // Close the MongoDB connection
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Run the seeding function
seedDatabase();