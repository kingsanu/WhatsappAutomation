#!/usr/bin/env node

/**
 * Test script to verify automatic key refresh functionality
 * This script simulates decryption errors and tests the key refresh mechanism
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
const TEST_USER = process.argv[2] || 'ko9kk';

async function testKeyRefresh() {
  console.log('🔧 Testing Automatic Key Refresh Functionality...\n');

  try {
    // Step 1: Check current session status
    console.log('📊 Step 1: Checking current session status...');
    const statusResponse = await axios.get(`${BASE_URL}/session/detailed/${TEST_USER}`);
    console.log('✅ Session status:', {
      connected: statusResponse.data.data.connected,
      connectionStatus: statusResponse.data.data.connectionStatus,
      lastKeyRefresh: statusResponse.data.data.lastKeyRefresh,
      keyRefreshReason: statusResponse.data.data.keyRefreshReason
    });

    // Step 2: Try to send a message to trigger potential decryption errors
    console.log('\n📤 Step 2: Attempting to send a test message...');
    try {
      const messageResponse = await axios.post(`${BASE_URL}/send-message`, {
        userId: TEST_USER,
        jid: '917508670783@s.whatsapp.net', // Send to self
        message: 'Test message to trigger key refresh if needed - ' + new Date().toISOString()
      });
      console.log('✅ Message sent successfully:', messageResponse.data);
    } catch (messageError) {
      console.log('❌ Message send failed:', messageError.response?.data || messageError.message);
      
      // Check if this was due to session issues
      if (messageError.response?.data?.message?.includes('session') || 
          messageError.response?.data?.message?.includes('decrypt') ||
          messageError.response?.data?.message?.includes('establish')) {
        console.log('🔄 Detected potential session/decryption issue, checking for key refresh...');
        
        // Wait a moment for potential key refresh to occur
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check session status again
        const updatedStatusResponse = await axios.get(`${BASE_URL}/session/detailed/${TEST_USER}`);
        const updatedData = updatedStatusResponse.data.data;
        
        console.log('📊 Updated session status after error:', {
          connected: updatedData.connected,
          connectionStatus: updatedData.connectionStatus,
          lastKeyRefresh: updatedData.lastKeyRefresh,
          keyRefreshReason: updatedData.keyRefreshReason,
          lastDisconnectReason: updatedData.lastDisconnectReason
        });
        
        if (updatedData.lastKeyRefresh && 
            new Date(updatedData.lastKeyRefresh) > new Date(Date.now() - 10000)) {
          console.log('🎉 Key refresh was triggered successfully!');
        } else {
          console.log('⚠️ No recent key refresh detected');
        }
      }
    }

    // Step 3: Check session health
    console.log('\n🏥 Step 3: Checking session health...');
    try {
      const healthResponse = await axios.get(`${BASE_URL}/session/health/${TEST_USER}`);
      console.log('✅ Session health:', healthResponse.data);
    } catch (healthError) {
      console.log('❌ Health check failed:', healthError.response?.data || healthError.message);
    }

    // Step 4: Try to activate session if needed
    console.log('\n🔄 Step 4: Attempting session activation if needed...');
    try {
      const activateResponse = await axios.post(`${BASE_URL}/session/activate/${TEST_USER}`);
      console.log('✅ Session activation:', activateResponse.data);
    } catch (activateError) {
      console.log('❌ Session activation failed:', activateError.response?.data || activateError.message);
    }

    // Step 5: Final status check
    console.log('\n📊 Step 5: Final session status check...');
    const finalStatusResponse = await axios.get(`${BASE_URL}/session/detailed/${TEST_USER}`);
    const finalData = finalStatusResponse.data.data;
    
    console.log('✅ Final session status:', {
      connected: finalData.connected,
      connectionStatus: finalData.connectionStatus,
      lastKeyRefresh: finalData.lastKeyRefresh,
      keyRefreshReason: finalData.keyRefreshReason,
      lastConnected: finalData.lastConnected,
      lastDisconnected: finalData.lastDisconnected,
      lastDisconnectReason: finalData.lastDisconnectReason,
      errorCount: finalData.errorCount,
      circuitBreakerState: finalData.circuitBreakerState
    });

    console.log('\n🎯 Key Refresh Test Summary:');
    console.log('- Session exists:', finalData.exists);
    console.log('- Currently connected:', finalData.connected);
    console.log('- Last key refresh:', finalData.lastKeyRefresh || 'Never');
    console.log('- Key refresh reason:', finalData.keyRefreshReason || 'N/A');
    console.log('- Error count:', finalData.errorCount);
    console.log('- Circuit breaker state:', finalData.circuitBreakerState);

    if (finalData.lastKeyRefresh) {
      const refreshAge = Date.now() - new Date(finalData.lastKeyRefresh).getTime();
      console.log('- Key refresh age:', Math.round(refreshAge / 1000), 'seconds ago');
      
      if (refreshAge < 60000) { // Less than 1 minute
        console.log('🎉 Recent key refresh detected - functionality is working!');
      } else {
        console.log('⚠️ Key refresh is old - may need investigation');
      }
    } else {
      console.log('ℹ️ No key refresh recorded - this is normal if no decryption errors occurred');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the test
testKeyRefresh().catch(console.error);
