const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/v1';

async function testErrorHandling() {
  console.log('🧪 Testing Error Handling and Application Stability...\n');

  try {
    // 1. Clear all sessions first
    console.log('1️⃣ Clearing all existing sessions...');
    try {
      await axios.delete(`${BASE_URL}/session/clear-all`);
      console.log('✅ All sessions cleared');
    } catch (error) {
      console.log('⚠️ Clear sessions response:', error.response?.status);
    }
    console.log('');

    // 2. Test multiple concurrent session creations (this should cause conflicts)
    console.log('2️⃣ Testing concurrent session creation (should cause conflicts)...');
    const userIds = ['test-user-1', 'test-user-2', 'test-user-3'];
    
    const promises = userIds.map(async (userId) => {
      try {
        const response = await axios.get(`${BASE_URL}/session/qr/${userId}/image`);
        console.log(`✅ QR generated for ${userId}`);
        return { userId, success: true };
      } catch (error) {
        console.log(`❌ QR failed for ${userId}:`, error.response?.status);
        return { userId, success: false, error: error.message };
      }
    });

    const results = await Promise.allSettled(promises);
    console.log('Concurrent creation results:', results.map(r => r.value || r.reason));
    console.log('');

    // 3. Wait a bit and check if server is still running
    console.log('3️⃣ Waiting 10 seconds to see if server crashes...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // 4. Test server health after potential errors
    console.log('4️⃣ Testing server health after potential errors...');
    try {
      const healthResponse = await axios.get(`${BASE_URL}/health`);
      console.log('✅ Server is still healthy:', healthResponse.data.status);
    } catch (error) {
      console.log('❌ Server health check failed:', error.message);
      return; // Exit if server is down
    }
    console.log('');

    // 5. Test session status for all users
    console.log('5️⃣ Checking session status for all test users...');
    for (const userId of userIds) {
      try {
        const statusResponse = await axios.get(`${BASE_URL}/session/status/${userId}`);
        console.log(`${userId} status:`, {
          connected: statusResponse.data.connected,
          connectionStatus: statusResponse.data.connectionStatus,
          exists: statusResponse.data.exists
        });
      } catch (error) {
        console.log(`❌ Status check failed for ${userId}:`, error.response?.status);
      }
    }
    console.log('');

    // 6. Test system statistics
    console.log('6️⃣ Checking system statistics...');
    try {
      const statsResponse = await axios.get(`${BASE_URL}/users/system/stats`);
      console.log('System stats:', {
        totalUsers: statsResponse.data.data.database.totalUsers,
        activeSessionCount: statsResponse.data.data.sessions.activeSessionCount,
        connectedSessionCount: statsResponse.data.data.sessions.connectedSessionCount,
        memoryUsageMB: statsResponse.data.data.system.memoryUsageMB
      });
    } catch (error) {
      console.log('❌ Stats check failed:', error.response?.status);
    }
    console.log('');

    // 7. Test clearing conflicted sessions
    console.log('7️⃣ Testing conflict cleanup...');
    try {
      await axios.delete(`${BASE_URL}/session/clear-conflicts`);
      console.log('✅ Conflicted sessions cleared');
    } catch (error) {
      console.log('❌ Conflict cleanup failed:', error.response?.status);
    }
    console.log('');

    // 8. Final health check
    console.log('8️⃣ Final server health check...');
    try {
      const finalHealthResponse = await axios.get(`${BASE_URL}/health`);
      console.log('✅ Final server status:', finalHealthResponse.data.status);
      console.log('Server uptime:', finalHealthResponse.data.uptime, 'seconds');
    } catch (error) {
      console.log('❌ Final health check failed:', error.message);
    }

  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
  }
}

// Run the test
testErrorHandling().then(() => {
  console.log('\n✅ Error handling test completed');
  console.log('🎯 Key things to verify:');
  console.log('   - Server should NOT crash during the test');
  console.log('   - Health endpoints should remain responsive');
  console.log('   - Errors should be logged but not crash the app');
  console.log('   - Conflicted sessions should be cleanable');
}).catch(error => {
  console.error('❌ Test error:', error.message);
});
