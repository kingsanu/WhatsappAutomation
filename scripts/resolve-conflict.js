#!/usr/bin/env node

/**
 * WhatsApp Session Conflict Resolution Script
 * This script helps resolve session conflicts automatically
 */

const axios = require('axios');
const readline = require('readline');

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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(`${colors.cyan}${question}${colors.reset}`, resolve);
  });
}

async function checkConflicts() {
  try {
    info('Checking for conflicted sessions...');
    const response = await axios.get(`${API_BASE_URL}/session/conflicts`);
    return response.data.data;
  } catch (err) {
    error('Failed to check conflicts: ' + err.message);
    return [];
  }
}

async function getSessionStatus(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/status/${username}`);
    return response.data.data;
  } catch (err) {
    warning(`Could not get session status for ${username}: ${err.message}`);
    return null;
  }
}

async function resolveConflict(username, method = 'resolve') {
  try {
    let endpoint;
    switch (method) {
      case 'resolve':
        endpoint = `${API_BASE_URL}/session/conflicts/${username}/resolve`;
        break;
      case 'takeover':
        endpoint = `${API_BASE_URL}/session/conflicts/${username}/force-takeover`;
        break;
      case 'clear':
        endpoint = `${API_BASE_URL}/session/conflicts/${username}`;
        break;
      default:
        throw new Error('Invalid resolution method');
    }

    const response = method === 'clear' 
      ? await axios.delete(endpoint)
      : await axios.post(endpoint);
    
    return response.data;
  } catch (err) {
    error(`Failed to ${method} conflict: ${err.message}`);
    return null;
  }
}

async function createNewSession(username) {
  try {
    info(`Creating new session for ${username}...`);
    const response = await axios.get(`${API_BASE_URL}/session/qr/${username}`);
    return response.data;
  } catch (err) {
    error(`Failed to create new session: ${err.message}`);
    return null;
  }
}

async function main() {
  log('🔧 WhatsApp Session Conflict Resolution Tool', 'cyan');
  log('================================================', 'cyan');
  
  if (!USERNAME) {
    error('Usage: node resolve-conflict.js <username>');
    error('Example: node resolve-conflict.js john_doe');
    process.exit(1);
  }

  log(`\n🎯 Resolving conflicts for user: ${USERNAME}`, 'blue');

  // Step 1: Check current conflicts
  log('\n📊 Step 1: Checking current conflicts...', 'yellow');
  const conflicts = await checkConflicts();
  
  if (conflicts.length === 0) {
    success('No conflicts found in the system!');
  } else {
    warning(`Found ${conflicts.length} conflicted session(s):`);
    conflicts.forEach(conflict => {
      log(`  - ${conflict.userId}: ${conflict.conflictCount} conflicts, status: ${conflict.connectionStatus}`);
    });
  }

  // Step 2: Check specific user status
  log('\n🔍 Step 2: Checking user session status...', 'yellow');
  const sessionStatus = await getSessionStatus(USERNAME);
  
  if (sessionStatus) {
    log(`Session Status: ${sessionStatus.status}`);
    log(`Connected: ${sessionStatus.connected}`);
    log(`Last Activity: ${sessionStatus.lastActivity || 'Never'}`);
    
    if (sessionStatus.status === 'stream_conflict' || sessionStatus.status === 'conflict') {
      warning('Session is in conflict state!');
    }
  }

  // Step 3: Choose resolution method
  log('\n🛠️  Step 3: Choose resolution method...', 'yellow');
  log('Available methods:');
  log('1. Gentle Resolution (recommended) - Clear conflict and prepare for new connection');
  log('2. Force Takeover - Completely clear all sessions and start fresh');
  log('3. Clear Conflict Only - Just remove conflict flag');
  log('4. Skip resolution - Just try to create new session');

  const choice = await askQuestion('\nEnter your choice (1-4): ');

  let resolutionMethod;
  switch (choice.trim()) {
    case '1':
      resolutionMethod = 'resolve';
      break;
    case '2':
      resolutionMethod = 'takeover';
      break;
    case '3':
      resolutionMethod = 'clear';
      break;
    case '4':
      resolutionMethod = 'skip';
      break;
    default:
      warning('Invalid choice, using gentle resolution...');
      resolutionMethod = 'resolve';
  }

  // Step 4: Execute resolution
  if (resolutionMethod !== 'skip') {
    log(`\n🔧 Step 4: Executing ${resolutionMethod} resolution...`, 'yellow');
    const result = await resolveConflict(USERNAME, resolutionMethod);
    
    if (result) {
      success(`Resolution completed: ${result.message}`);
      if (result.data && result.data.nextSteps) {
        log('\nNext steps:');
        result.data.nextSteps.forEach(step => log(`  • ${step}`));
      }
    } else {
      error('Resolution failed!');
      process.exit(1);
    }
  }

  // Step 5: Ask about creating new session
  log('\n🚀 Step 5: Create new session?', 'yellow');
  const createSession = await askQuestion('Do you want to create a new session now? (y/n): ');

  if (createSession.toLowerCase() === 'y' || createSession.toLowerCase() === 'yes') {
    log('\n📱 Creating new session...', 'yellow');
    const sessionResult = await createNewSession(USERNAME);
    
    if (sessionResult) {
      success('New session creation initiated!');
      if (sessionResult.qr) {
        log('\n📱 QR Code generated! Please scan it with your WhatsApp mobile app.');
        log('QR Code URL: ' + sessionResult.qr);
      }
      log('\nSession will be ready once you scan the QR code.');
    } else {
      error('Failed to create new session!');
    }
  }

  // Step 6: Final verification
  log('\n✅ Step 6: Final verification...', 'yellow');
  const finalConflicts = await checkConflicts();
  const userConflict = finalConflicts.find(c => c.userId === USERNAME);
  
  if (userConflict) {
    warning(`User ${USERNAME} still has conflicts. You may need to:`);
    log('  • Ensure WhatsApp is logged out on all other devices');
    log('  • Wait a few minutes and try again');
    log('  • Use force takeover method if gentle resolution failed');
  } else {
    success(`User ${USERNAME} is no longer in conflict state!`);
  }

  log('\n🎉 Conflict resolution process completed!', 'green');
  log('\n💡 Tips for preventing future conflicts:', 'cyan');
  log('  • Use a dedicated phone number for API only');
  log('  • Avoid using WhatsApp Web with API numbers');
  log('  • Run only one API instance per phone number');
  log('  • Monitor session health regularly');

  rl.close();
}

// Handle script interruption
process.on('SIGINT', () => {
  log('\n\n👋 Script interrupted by user', 'yellow');
  rl.close();
  process.exit(0);
});

// Run main function
main().catch(error => {
  error('Fatal error: ' + error.message);
  rl.close();
  process.exit(1);
});
