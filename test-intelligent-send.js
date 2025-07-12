const fetch = require('node-fetch');

async function testIntelligentSend() {
    try {
        console.log('🚀 Testing Intelligent Message Sending...');
        
        const response = await fetch('http://localhost:3000/client/sendMessage/kokk4', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                number: '917508670783',
                message: '🧠 Testing intelligent session activation! This message should automatically activate the session if needed. Time: ' + new Date().toLocaleTimeString()
            })
        });

        const result = await response.json();
        
        console.log('📤 Response Status:', response.status);
        console.log('📋 Response Body:', JSON.stringify(result, null, 2));
        
        if (response.ok) {
            console.log('✅ SUCCESS: Message sent successfully!');
            if (result.retried) {
                console.log('🔄 Message was sent after retry with session reactivation');
            }
        } else {
            console.log('❌ FAILED: Message sending failed');
        }
        
    } catch (error) {
        console.error('💥 ERROR:', error.message);
    }
}

testIntelligentSend();
