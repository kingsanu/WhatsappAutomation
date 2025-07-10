const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/v1';
const USERNAME = 'test-user'; // Change this to your test username

async function testSessionStatus() {
  console.log('🧪 Testing Session Status Detection...\n');

  try {
    // 1. Check initial status
    console.log('1️⃣ Checking initial session status...');
    let response = await axios.get(`${BASE_URL}/session/status/${USERNAME}`);
    console.log('Initial Status:', {
      connected: response.data.connected,
      connectionStatus: response.data.connectionStatus,
      exists: response.data.exists,
      isSessionActive: response.data.isSessionActive
    });
    console.log('');

    // 2. Generate QR code (this will create the session)
    console.log('2️⃣ Generating QR code...');
    try {
      await axios.get(`${BASE_URL}/session/qr/${USERNAME}/image`);
      console.log('✅ QR code generated successfully');
    } catch (error) {
      console.log('QR generation response:', error.response?.status);
    }
    console.log('');

    // 3. Check status after QR generation
    console.log('3️⃣ Checking status after QR generation...');
    response = await axios.get(`${BASE_URL}/session/status/${USERNAME}`);
    console.log('After QR Status:', {
      connected: response.data.connected,
      connectionStatus: response.data.connectionStatus,
      exists: response.data.exists,
      isSessionActive: response.data.isSessionActive,
      inMemoryConnected: response.data.inMemoryConnected,
      isInitialConnection: response.data.isInitialConnection,
      validationResult: response.data.validationResult
    });
    console.log('');

    // 4. Monitor status changes
    console.log('4️⃣ Monitoring status changes (scan QR code now)...');
    console.log('Please scan the QR code with your WhatsApp mobile app');
    console.log('Monitoring for 60 seconds...\n');

    for (let i = 0; i < 12; i++) { // Check every 5 seconds for 1 minute
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      try {
        response = await axios.get(`${BASE_URL}/session/status/${USERNAME}`);
        console.log(`Check ${i + 1}/12:`, {
          time: new Date().toLocaleTimeString(),
          connected: response.data.connected,
          connectionStatus: response.data.connectionStatus,
          socketState: response.data.socketState,
          inMemoryConnected: response.data.inMemoryConnected,
          isInitialConnection: response.data.isInitialConnection
        });

        // If connected, break the loop
        if (response.data.connected) {
          console.log('🎉 Connection detected! Monitoring for stability...');
          
          // Check a few more times to ensure it stays connected
          for (let j = 0; j < 3; j++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const stabilityCheck = await axios.get(`${BASE_URL}/session/status/${USERNAME}`);
            console.log(`Stability check ${j + 1}/3:`, {
              connected: stabilityCheck.data.connected,
              connectionStatus: stabilityCheck.data.connectionStatus
            });
          }
          break;
        }
      } catch (error) {
        console.log(`Check ${i + 1}/12: Error -`, error.message);
      }
    }

    // 5. Final status check
    console.log('\n5️⃣ Final status check...');
    response = await axios.get(`${BASE_URL}/session/status/${USERNAME}`);
    console.log('Final Status:', {
      connected: response.data.connected,
      connectionStatus: response.data.connectionStatus,
      user: response.data.user ? 'Present' : 'Not present',
      lastValidated: response.data.lastValidated
    });

    // 6. Test validation endpoint
    console.log('\n6️⃣ Testing validation endpoint...');
    try {
      const validationResponse = await axios.get(`${BASE_URL}/session/validate/${USERNAME}`);
      console.log('Validation Result:', validationResponse.data);
    } catch (error) {
      console.log('Validation Error:', error.response?.data || error.message);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

// Run the test
testSessionStatus().then(() => {
  console.log('\n✅ Test completed');
}).catch(error => {
  console.error('❌ Test error:', error.message);
});
