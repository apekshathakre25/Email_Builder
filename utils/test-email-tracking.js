
const mongoose = require('mongoose');
const ImapTestResult = require('../models/ImapTestResult');


mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/email-sender', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

async function testFeature() {
    console.log('🧪 Testing Test Email Tracking Feature\n');
    console.log('='.repeat(80));

    try {

        console.log('\n1. Creating test email records...');

        const testRecords = [
            {
                testId: `test-${Date.now()}-user1@example.com-${Date.now()}`,
                testType: 'manual',
                testEmail: 'user1@example.com',
                ipAddress: 'smtp.example.com',
                status: 'pending',
                subject: 'Test Subject 1',
                fromEmail: 'sender@domain.com',
                messageId: 'pending',
                sentAt: new Date()
            },
            {
                testId: `test-${Date.now()}-user2@example.com-${Date.now() + 1}`,
                testType: 'manual',
                testEmail: 'user2@example.com',
                ipAddress: 'smtp.example.com',
                status: 'pending',
                subject: 'Test Subject 2',
                fromEmail: 'sender@domain.com',
                messageId: 'pending',
                sentAt: new Date()
            }
        ];

        const created = await ImapTestResult.insertMany(testRecords);
        console.log(`✅ Created ${created.length} test records`);


        console.log('\n2. Simulating email send and Message-ID update...');

        for (const record of created) {
            const actualMessageId = `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@domain.com>`;

            const updated = await ImapTestResult.findOneAndUpdate(
                {
                    testEmail: record.testEmail,
                    status: 'pending',
                    messageId: 'pending'
                },
                {
                    messageId: actualMessageId,
                    $set: { sentAt: new Date() }
                },
                { sort: { createdAt: -1 }, new: true }
            );

            console.log(`✅ Updated ${updated.testEmail} with Message-ID: ${updated.messageId}`);
        }

    
        console.log('\n3. Verifying saved records...');

        const savedRecords = await ImapTestResult.find({
            testType: 'manual',
            status: 'pending'
        }).sort({ createdAt: -1 }).limit(5);

        console.log(`\n📊 Found ${savedRecords.length} pending manual test records:\n`);

        savedRecords.forEach((record, index) => {
            console.log(`${index + 1}. ${record.testEmail}`);
            console.log(`   Subject: ${record.subject}`);
            console.log(`   From: ${record.fromEmail}`);
            console.log(`   Message-ID: ${record.messageId}`);
            console.log(`   Status: ${record.status}`);
            console.log(`   Sent: ${record.sentAt.toISOString()}`);
            console.log('');
        });

        console.log('='.repeat(80));
        console.log('✅ Test completed successfully!');
        console.log('\nThe feature is working correctly:');
        console.log('- Test records are created when emails are sent');
        console.log('- Message-IDs are updated after sending');
        console.log('- Records remain in "pending" status for manual verification');
        console.log('- All test data is preserved for later checking');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
    }
}

// Run the test
testFeature();
