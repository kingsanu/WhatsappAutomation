#!/usr/bin/env node

/**
 * Test script for smart conflict resolution
 * This script demonstrates the new conflict handling capabilities
 */

const axios = require('axios');
const readline = require('readline');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const USERNAME = process.argv[2] || 'ko9kk';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function log(message, color = 'white') {
  const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    reset: '\x1b[0m'
  };
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message) { log(`✅ ${message}`, 'green'); }
function error(message) { log(`❌ ${message}`, 'red'); }
function warning(message) { log(`⚠️  ${message}`, 'yellow'); }

async function getSessionStatus(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/detailed/${username}`);
    return response.data.data;
  } catch (err) {
    error(`Failed to get session status: ${err.message}`);
    return null;
  }
}

async function getConflicts() {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/conflicts`);
    return response.data.data;
  } catch (err) {
    error(`Failed to get conflicts: ${err.message}`);
    return null;
  }
}

async function clearConflict(username) {
  try {
    const response = await axios.delete(`${API_BASE_URL}/session/conflicts/${username}`);
    return response.data;
  } catch (err) {
    error(`Failed to clear conflict: ${err.message}`);
    return null;
  }
}

async function createSession(username) {
  try {
    const response = await axios.post(`${API_BASE_URL}/session/qr/${username}`);
    return response.data;
  } catch (err) {
    error(`Failed to create session: ${err.message}`);
    return null;
  }
}

async function activateSession(username) {
  try {
    const response = await axios.post(`${API_BASE_URL}/session/activate/${username}`);
    return response.data;
  } catch (err) {
    error(`Failed to activate session: ${err.message}`);
    return null;
  }
}

async function main() {
  log('🧪 Smart Conflict Resolution Test', 'cyan');
  log('=====================================', 'cyan');
  log(`Testing with username: ${USERNAME}`, 'blue');

  // Step 1: Check current status
  log('\n📊 Step 1: Checking current session status...', 'yellow');
  const status = await getSessionStatus(USERNAME);

  if (status) {
    log(`Connection Status: ${status.connectionStatus}`);
    log(`Connected: ${status.connected}`);
    log(`Last Connected: ${status.lastConnected || 'Never'}`);
    log(`Last Disconnect Reason: ${status.lastDisconnectReason || 'Unknown'}`);
    log(`Auto Reconnect: ${status.autoReconnect}`);
    log(`Circuit Breaker: ${status.circuitBreakerState}`);
    log(`Error Count: ${status.errorCount || 0}`);

    if (status.connectionStatus === 'stream_conflict') {
      warning('Session is currently in conflict state!');
    }
  }

  // Step 1.5: Check conflicts list
  log('\n🔍 Step 1.5: Checking conflicts list...', 'yellow');
  const conflicts = await getConflicts();

  if (conflicts && conflicts.length > 0) {
    log(`Found ${conflicts.length} conflicted sessions:`);
    conflicts.forEach(conflict => {
      log(`  - ${conflict.userId}: ${conflict.conflictCount} conflicts, status: ${conflict.connectionStatus}`);
    });
  } else {
    success('No conflicted sessions found!');
  }

  // Step 2: Test conflict clearing
  log('\n🧹 Step 2: Testing smart conflict clearing...', 'yellow');
  const clearResult = await clearConflict(USERNAME);
  
  if (clearResult && clearResult.success) {
    success('Conflict state cleared successfully');
  } else {
    warning('Failed to clear conflict or no conflict to clear');
  }

  // Step 3: Check status after clearing
  log('\n🔍 Step 3: Checking status after conflict clearing...', 'yellow');
  const statusAfterClear = await getSessionStatus(USERNAME);

  if (statusAfterClear) {
    log(`New Status: ${statusAfterClear.connectionStatus}`);
    log(`Circuit Breaker: ${statusAfterClear.circuitBreakerState}`);
    log(`Error Count: ${statusAfterClear.errorCount || 0}`);
    log(`Auto Reconnect: ${statusAfterClear.autoReconnect}`);
  }

  // Check conflicts list again
  const conflictsAfterClear = await getConflicts();
  if (conflictsAfterClear && conflictsAfterClear.length === 0) {
    success('Conflicts list is now empty!');
  } else {
    warning(`Still ${conflictsAfterClear?.length || 0} conflicts remaining`);
  }

  // Step 4: Test session activation
  log('\n🚀 Step 4: Testing session activation...', 'yellow');
  const choice = await askQuestion('Do you want to try activating the session? (y/n): ');
  
  if (choice.toLowerCase() === 'y') {
    log('Attempting to activate session...');
    const activateResult = await activateSession(USERNAME);
    
    if (activateResult && activateResult.success) {
      success('Session activation initiated successfully');
    } else {
      warning('Session activation failed - this might be expected if no valid auth data exists');
      
      const createChoice = await askQuestion('Do you want to create a new session with QR? (y/n): ');
      if (createChoice.toLowerCase() === 'y') {
        log('Creating new session...');
        const createResult = await createSession(USERNAME);
        
        if (createResult && createResult.success) {
          success('New session created successfully');
          log('QR Code should be available now');
        } else {
          error('Failed to create new session');
        }
      }
    }
  }

  // Step 5: Final status check
  log('\n✅ Step 5: Final status check...', 'yellow');
  const finalStatus = await getSessionStatus(USERNAME);

  if (finalStatus) {
    log(`Final Status: ${finalStatus.connectionStatus}`);
    log(`Connected: ${finalStatus.connected}`);
    log(`Circuit Breaker: ${finalStatus.circuitBreakerState}`);
    log(`Error Count: ${finalStatus.errorCount || 0}`);

    if (finalStatus.connectionStatus === 'stream_conflict') {
      warning('Session is still in conflict - this indicates the smart resolution needs more time');
      log('The new system uses progressive backoff instead of permanent blocking');
      log('Try again in a few minutes, or check if WhatsApp is active on other devices');
    } else {
      success('Session is no longer in permanent conflict state!');
    }
  }

  // Final conflicts check
  const finalConflicts = await getConflicts();
  if (finalConflicts && finalConflicts.length === 0) {
    success('No conflicts detected in final check!');
  } else {
    log(`Final conflicts count: ${finalConflicts?.length || 0}`);
  }

  log('\n🎉 Test completed!', 'green');
  log('Key improvements:', 'cyan');
  log('• Conflicts no longer permanently block sessions', 'cyan');
  log('• Progressive backoff allows eventual recovery', 'cyan');
  log('• Instance tracking prevents server restart conflicts', 'cyan');
  log('• Smart restoration logic reduces conflict probability', 'cyan');

  rl.close();
}

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
  error(`Unhandled error: ${error.message}`);
  process.exit(1);
});

// Run the test
main().catch((err) => {
  error(`Test failed: ${err.message}`);
  process.exit(1);
});
