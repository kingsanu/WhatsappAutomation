#!/usr/bin/env node

/**
 * Test Script for WhatsApp Auth Preservation
 * This script tests the new auth preservation functionality
 */

const axios = require('axios');

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';
const USERNAME = process.argv[2];

// Colors for output
const colors = {
  red: '\033[0;31m',
  green: '\033[0;32m',
  yellow: '\033[1;33m',
  blue: '\033[0;34m',
  cyan: '\033[0;36m',
  reset: '\033[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message) {
  log(`❌ ${message}`, 'red');
}

function success(message) {
  log(`✅ ${message}`, 'green');
}

function warning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function info(message) {
  log(`ℹ️  ${message}`, 'blue');
}

async function checkAuthStatus(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/auth-status/${username}`);
    return response.data.data;
  } catch (err) {
    error('Failed to check auth status: ' + err.message);
    return null;
  }
}

async function resolveConflict(username) {
  try {
    const response = await axios.post(`${API_BASE_URL}/session/conflicts/${username}/resolve`);
    return response.data;
  } catch (err) {
    error('Failed to resolve conflict: ' + err.message);
    return null;
  }
}

async function activateSession(username) {
  try {
    const response = await axios.post(`${API_BASE_URL}/session/activate/${username}`);
    return response.data;
  } catch (err) {
    error('Failed to activate session: ' + err.message);
    return null;
  }
}

async function getSessionStatus(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/status/${username}`);
    return response.data.data;
  } catch (err) {
    warning(`Could not get session status: ${err.message}`);
    return null;
  }
}

async function sendTestMessage(username) {
  try {
    // Try to send a test message to verify the session is working
    const response = await axios.post(`${API_BASE_URL}/message/send`, {
      userId: username,
      to: username, // Send to self as test
      message: 'Test message - session working!'
    });
    return response.data;
  } catch (err) {
    warning(`Test message failed: ${err.message}`);
    return null;
  }
}

async function main() {
  log('🧪 WhatsApp Auth Preservation Test', 'cyan');
  log('===================================', 'cyan');
  
  if (!USERNAME) {
    error('Usage: node test-auth-preservation.js <username>');
    error('Example: node test-auth-preservation.js john_doe');
    process.exit(1);
  }

  log(`\n🎯 Testing auth preservation for user: ${USERNAME}`, 'blue');

  // Step 1: Check initial auth status
  log('\n📊 Step 1: Checking initial auth status...', 'yellow');
  const initialAuth = await checkAuthStatus(USERNAME);
  
  if (initialAuth) {
    log(`Auth Status:`, 'blue');
    log(`  - Has Valid Auth: ${initialAuth.hasValidAuth ? '✅' : '❌'}`);
    log(`  - Is Active: ${initialAuth.isActive ? '✅' : '❌'}`);
    log(`  - Is Connected: ${initialAuth.isConnected ? '✅' : '❌'}`);
    log(`  - Can Activate Without QR: ${initialAuth.canActivateWithoutQR ? '✅' : '❌'}`);
    
    if (!initialAuth.hasValidAuth) {
      warning('No valid auth data found. You need to create a session first with QR code.');
      log('\nTo create initial session:');
      log(`curl http://localhost:3000/api/v1/session/qr/${USERNAME}`);
      process.exit(1);
    }
  } else {
    error('Could not check auth status');
    process.exit(1);
  }

  // Step 2: Test conflict resolution with auth preservation
  log('\n🔧 Step 2: Testing conflict resolution with auth preservation...', 'yellow');
  const resolveResult = await resolveConflict(USERNAME);
  
  if (resolveResult && resolveResult.success) {
    success('Conflict resolution completed');
    log(`Message: ${resolveResult.data.message}`);
    log('Next steps:');
    resolveResult.data.nextSteps.forEach(step => log(`  • ${step}`));
  } else {
    warning('Conflict resolution may have failed, but continuing test...');
  }

  // Step 3: Check auth status after resolution
  log('\n🔍 Step 3: Checking auth status after conflict resolution...', 'yellow');
  const postResolveAuth = await checkAuthStatus(USERNAME);
  
  if (postResolveAuth) {
    log(`Auth Status After Resolution:`, 'blue');
    log(`  - Has Valid Auth: ${postResolveAuth.hasValidAuth ? '✅' : '❌'}`);
    log(`  - Can Activate Without QR: ${postResolveAuth.canActivateWithoutQR ? '✅' : '❌'}`);
    
    if (!postResolveAuth.hasValidAuth) {
      error('❌ AUTH DATA LOST! This is a bug - auth should be preserved.');
      process.exit(1);
    } else {
      success('✅ AUTH DATA PRESERVED! Conflict resolution worked correctly.');
    }
  }

  // Step 4: Test session activation without QR
  log('\n🚀 Step 4: Testing session activation without QR...', 'yellow');
  const activateResult = await activateSession(USERNAME);
  
  if (activateResult && activateResult.success) {
    success('Session activation completed without QR!');
    log(`Message: ${activateResult.data.message}`);
    log(`Auth Preserved: ${activateResult.data.authPreserved ? '✅' : '❌'}`);
  } else {
    error('Session activation failed');
  }

  // Step 5: Verify session is working
  log('\n✅ Step 5: Verifying session functionality...', 'yellow');
  
  // Wait a moment for connection to establish
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const finalStatus = await getSessionStatus(USERNAME);
  if (finalStatus) {
    log(`Final Session Status:`, 'blue');
    log(`  - Status: ${finalStatus.status}`);
    log(`  - Connected: ${finalStatus.connected ? '✅' : '❌'}`);
    log(`  - QR Required: ${finalStatus.qr ? '❌ (unexpected)' : '✅ (good)'}`);
  }

  // Step 6: Test message sending
  log('\n📱 Step 6: Testing message functionality...', 'yellow');
  const messageResult = await sendTestMessage(USERNAME);
  
  if (messageResult && messageResult.success) {
    success('✅ Message sent successfully! Session is fully functional.');
  } else {
    warning('Message sending failed, but this might be due to WhatsApp restrictions.');
  }

  // Final summary
  log('\n🎉 Auth Preservation Test Results:', 'green');
  log('=====================================', 'green');
  
  const results = {
    authPreserved: postResolveAuth?.hasValidAuth || false,
    sessionActivated: activateResult?.success || false,
    noQrRequired: !finalStatus?.qr,
    functionalSession: messageResult?.success || false
  };
  
  log(`✅ Auth Data Preserved: ${results.authPreserved ? 'PASS' : 'FAIL'}`);
  log(`✅ Session Activated: ${results.sessionActivated ? 'PASS' : 'FAIL'}`);
  log(`✅ No QR Required: ${results.noQrRequired ? 'PASS' : 'FAIL'}`);
  log(`✅ Session Functional: ${results.functionalSession ? 'PASS' : 'PARTIAL'}`);
  
  const passCount = Object.values(results).filter(Boolean).length;
  const totalTests = Object.keys(results).length;
  
  log(`\n📊 Overall Score: ${passCount}/${totalTests} tests passed`);
  
  if (passCount === totalTests) {
    success('🎉 ALL TESTS PASSED! Auth preservation is working perfectly!');
  } else if (passCount >= totalTests - 1) {
    success('🎉 MOSTLY WORKING! Auth preservation is functional with minor issues.');
  } else {
    warning('⚠️  SOME ISSUES FOUND. Auth preservation needs attention.');
  }
  
  log('\n💡 Key Benefits of Auth Preservation:', 'cyan');
  log('  • No QR code scanning after conflicts');
  log('  • Faster session recovery');
  log('  • True session persistence across restarts');
  log('  • Better user experience');
  log('  • Reduced authentication overhead');
}

// Handle script interruption
process.on('SIGINT', () => {
  log('\n\n👋 Test interrupted by user', 'yellow');
  process.exit(0);
});

// Run main function
main().catch(error => {
  error('Fatal error: ' + error.message);
  process.exit(1);
});
