const mongoose = require('mongoose');

function connectMongoDB() {
  console.log('🔍 Checking MongoDB configuration...');
  console.log('Environment variables loaded:', Object.keys(process.env).filter(key => key.includes('MONGODB')));

  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI environment variable is required but not set!');
    console.error('📝 Please add your MongoDB Atlas connection string to your .env file, e.g.:');
    console.error('   MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/bulk-email-sender?retryWrites=true&w=majority');
    throw new Error('MONGODB_URI environment variable is required.');
  }

  const isAtlas = /mongodb\.net/i.test(process.env.MONGODB_URI);

  console.log(`🔗 Connecting to MongoDB${isAtlas ? ' Atlas' : ''}: ${process.env.MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

  mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });

  const db = mongoose.connection;

  db.on('connected', () => {
    console.log('✅ MongoDB connected successfully');
  });

  db.on('error', (err) => {
    console.error('❌ MongoDB connection error:', err.message);
    if (isAtlas) {
      console.error('💡 Atlas connection checklist:');
      console.error('   - Add your current IP to Atlas → Network Access → IP Access List');
      console.error('   - Verify the database user name/password in MONGODB_URI');
      console.error('   - If SRV lookup fails (ENOTFOUND/querySrv), use the standard mongodb:// string');
    } else if (err.code === 'ECONNREFUSED') {
      console.error('💡 Make sure MongoDB is running locally:');
      console.error('   - Check if MongoDB is installed: mongod --version');
      console.error('   - Start MongoDB, or use Docker: docker run -d -p 27017:27017 mongo:latest');
    }
    console.error('Full error:', err);
  });

  db.on('disconnected', () => {
    console.log('🔌 MongoDB connection disconnected');
  });

  return db;
}

module.exports = connectMongoDB;
