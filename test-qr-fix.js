#!/usr/bin/env node

/**
 * Test script to verify QR code improvements
 * This script tests the enhanced QR code functionality
 */

const axios = require('axios');

const API_BASE = 'http://localhost:3000';
const API_KEY = 'test_api_key'; // Change this to your API key
const TEST_SESSION_ID = `qr-test-${Date.now()}`;

const headers = {
  'x-api-key': API_KEY,
  'Content-Type': 'application/json'
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testQrImprovements() {
  console.log('🧪 Testing QR Code Improvements\n');
  console.log(`Test Session ID: ${TEST_SESSION_ID}\n`);

  try {
    // Test 1: Basic health check
    console.log('1️⃣ Testing server health...');
    try {
      const healthResponse = await axios.get(`${API_BASE}/ping`);
      console.log('✅ Server is healthy:', healthResponse.data.message);
    } catch (error) {
      console.log('❌ Server health check failed. Make sure server is running.');
      return;
    }

    // Test 2: Enhanced QR endpoint (auto-creates session)
    console.log('\n2️⃣ Testing enhanced QR endpoint (auto-creates session)...');
    try {
      const qrResponse = await axios.get(`${API_BASE}/session/qr/${TEST_SESSION_ID}`, { headers });
      
      if (qrResponse.data.success) {
        console.log('✅ QR code generated successfully!');
        console.log('📱 QR Code length:', qrResponse.data.qr ? qrResponse.data.qr.length : 'N/A');
        console.log('💬 Message:', qrResponse.data.message);
      } else {
        console.log('⚠️ QR generation response:', qrResponse.data);
      }
    } catch (error) {
      console.log('❌ QR endpoint error:', error.response?.data || error.message);
    }

    // Test 3: Session status check
    console.log('\n3️⃣ Checking session status...');
    try {
      const statusResponse = await axios.get(`${API_BASE}/session/status/${TEST_SESSION_ID}`, { headers });
      console.log('📊 Session status:', statusResponse.data);
    } catch (error) {
      console.log('⚠️ Status check error:', error.response?.data || error.message);
    }

    // Test 4: QR image endpoint
    console.log('\n4️⃣ Testing QR image endpoint...');
    try {
      const imageResponse = await axios.get(`${API_BASE}/session/qr/${TEST_SESSION_ID}/image`, { 
        headers,
        responseType: 'arraybuffer',
        timeout: 30000 // 30 second timeout
      });
      
      if (imageResponse.headers['content-type'] === 'image/png') {
        console.log('✅ QR image generated successfully!');
        console.log('🖼️ Image size:', imageResponse.data.length, 'bytes');
      } else {
        console.log('⚠️ Unexpected response type:', imageResponse.headers['content-type']);
      }
    } catch (error) {
      if (error.response?.data) {
        const errorText = Buffer.from(error.response.data).toString();
        try {
          const errorJson = JSON.parse(errorText);
          console.log('⚠️ QR image error:', errorJson);
        } catch {
          console.log('⚠️ QR image error (raw):', errorText.substring(0, 200));
        }
      } else {
        console.log('❌ QR image error:', error.message);
      }
    }

    // Test 5: Force QR regeneration
    console.log('\n5️⃣ Testing QR regeneration...');
    try {
      const regenResponse = await axios.get(`${API_BASE}/session/regenerateQr/${TEST_SESSION_ID}`, { headers });
      console.log('🔄 QR regeneration:', regenResponse.data);
      
      if (regenResponse.data.success) {
        console.log('⏳ Waiting 10 seconds for new QR...');
        await sleep(10000);
        
        // Try to get new QR
        const newQrResponse = await axios.get(`${API_BASE}/session/qr/${TEST_SESSION_ID}`, { headers });
        if (newQrResponse.data.success) {
          console.log('✅ New QR generated after regeneration!');
        } else {
          console.log('⚠️ New QR not ready yet:', newQrResponse.data.message);
        }
      }
    } catch (error) {
      console.log('⚠️ QR regeneration error:', error.response?.data || error.message);
    }

    // Test 6: Session statistics
    console.log('\n6️⃣ Checking session statistics...');
    try {
      const statsResponse = await axios.get(`${API_BASE}/session/stats`, { headers });
      console.log('📈 Session stats:', JSON.stringify(statsResponse.data, null, 2));
    } catch (error) {
      console.log('⚠️ Stats error:', error.response?.data || error.message);
    }

    // Test 7: All sessions info
    console.log('\n7️⃣ Getting all sessions info...');
    try {
      const allSessionsResponse = await axios.get(`${API_BASE}/session/all`, { headers });
      console.log('📋 All sessions:', JSON.stringify(allSessionsResponse.data, null, 2));
    } catch (error) {
      console.log('⚠️ All sessions error:', error.response?.data || error.message);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up test session...');
    try {
      await axios.get(`${API_BASE}/session/terminate/${TEST_SESSION_ID}`, { headers });
      console.log('✅ Test session terminated');
    } catch (error) {
      console.log('⚠️ Cleanup error (this is usually fine):', error.response?.data?.error || error.message);
    }
  }
}

async function demonstrateUsage() {
  console.log('\n📚 QR Code Usage Examples:\n');
  
  console.log('🔹 Basic QR retrieval (enhanced):');
  console.log(`curl -H "x-api-key: ${API_KEY}" ${API_BASE}/session/qr/YOUR_SESSION_ID\n`);
  
  console.log('🔹 QR as image:');
  console.log(`curl -H "x-api-key: ${API_KEY}" ${API_BASE}/session/qr/YOUR_SESSION_ID/image -o qr.png\n`);
  
  console.log('🔹 Force QR regeneration:');
  console.log(`curl -H "x-api-key: ${API_KEY}" ${API_BASE}/session/regenerateQr/YOUR_SESSION_ID\n`);
  
  console.log('🔹 Check session status:');
  console.log(`curl -H "x-api-key: ${API_KEY}" ${API_BASE}/session/status/YOUR_SESSION_ID\n`);
  
  console.log('🔹 Session statistics:');
  console.log(`curl -H "x-api-key: ${API_KEY}" ${API_BASE}/session/stats\n`);
}

function showTroubleshootingTips() {
  console.log('\n🔧 Troubleshooting Tips:\n');
  
  console.log('❌ If you get "qr code not ready or already scanned":');
  console.log('   1. Use the enhanced /session/qr/:sessionId endpoint (auto-waits)');
  console.log('   2. Try /session/regenerateQr/:sessionId to force new QR');
  console.log('   3. Check /session/status/:sessionId for session state');
  console.log('   4. Restart session with /session/restart/:sessionId\n');
  
  console.log('⏱️ If QR generation is slow:');
  console.log('   1. Check server resources (memory, CPU)');
  console.log('   2. Verify Chrome/Chromium is properly installed');
  console.log('   3. Check network connectivity to WhatsApp servers');
  console.log('   4. Reduce MAX_CONCURRENT_SESSIONS if needed\n');
  
  console.log('🔄 For persistent issues:');
  console.log('   1. Terminate and recreate the session');
  console.log('   2. Check server logs for detailed errors');
  console.log('   3. Verify API key is correct');
  console.log('   4. See QR_TROUBLESHOOTING.md for detailed guide\n');
}

async function main() {
  console.log('🚀 WhatsApp QR Code Fix Verification\n');
  console.log('This script tests the improved QR code functionality.\n');
  
  // Check if server is likely running
  try {
    await axios.get(`${API_BASE}/ping`, { timeout: 5000 });
  } catch (error) {
    console.log('⚠️  Server appears to be offline. Please start the server with:');
    console.log('   npm start\n');
    console.log('   Make sure to set API_KEY environment variable if needed.\n');
    demonstrateUsage();
    showTroubleshootingTips();
    return;
  }

  await testQrImprovements();
  demonstrateUsage();
  showTroubleshootingTips();
  
  console.log('✨ QR Code improvements testing completed!');
  console.log('📖 For detailed troubleshooting, see QR_TROUBLESHOOTING.md');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { testQrImprovements, demonstrateUsage, showTroubleshootingTips };
