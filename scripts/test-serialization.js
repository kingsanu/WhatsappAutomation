#!/usr/bin/env node

/**
 * Test Script for Session State Serialization
 * This script tests the advanced serialization functionality
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

async function getSerializationStats() {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/serialization/stats`);
    return response.data.data;
  } catch (err) {
    error('Failed to get serialization stats: ' + err.message);
    return null;
  }
}

async function getSerializationMetrics(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/serialization/metrics/${username}`);
    return response.data.data;
  } catch (err) {
    warning(`Failed to get serialization metrics for ${username}: ${err.message}`);
    return null;
  }
}

async function validateSerializationIntegrity(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/serialization/validate/${username}`);
    return response.data.data;
  } catch (err) {
    error(`Failed to validate serialization integrity for ${username}: ${err.message}`);
    return null;
  }
}

async function forceSave(username) {
  try {
    const response = await axios.post(`${API_BASE_URL}/session/serialization/force-save/${username}`);
    return response.data;
  } catch (err) {
    error(`Failed to force save for ${username}: ${err.message}`);
    return null;
  }
}

async function getAuthStatus(username) {
  try {
    const response = await axios.get(`${API_BASE_URL}/session/auth-status/${username}`);
    return response.data.data;
  } catch (err) {
    warning(`Could not get auth status for ${username}: ${err.message}`);
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function main() {
  log('🧪 Session State Serialization Test', 'cyan');
  log('====================================', 'cyan');
  
  if (!USERNAME) {
    error('Usage: node test-serialization.js <username>');
    error('Example: node test-serialization.js john_doe');
    process.exit(1);
  }

  log(`\n🎯 Testing serialization for user: ${USERNAME}`, 'blue');

  // Step 1: Get overall serialization statistics
  log('\n📊 Step 1: Getting overall serialization statistics...', 'yellow');
  const stats = await getSerializationStats();
  
  if (stats) {
    log('System Serialization Stats:', 'blue');
    log(`  • Total States: ${stats.totalStates}`);
    log(`  • Compressed States: ${stats.compressedStates}`);
    log(`  • Compression Rate: ${stats.compressionRate}`);
    log(`  • Avg Compression Ratio: ${stats.avgCompressionRatio}x`);
    log(`  • Avg Serialization Time: ${stats.avgSerializationTime}ms`);
    log(`  • Avg Deserialization Time: ${stats.avgDeserializationTime}ms`);
    log(`  • Total Original Size: ${stats.totalOriginalSize}`);
    log(`  • Total Compressed Size: ${stats.totalCompressedSize}`);
    log(`  • Space Saved: ${stats.spaceSaved}`);
    log(`  • Serialization Version: ${stats.serializationVersion}`);
    log(`  • Cache Size: ${stats.cacheSize}`);
    log(`  • Metrics Count: ${stats.metricsCount}`);
    
    if (stats.error) {
      warning(`Stats Error: ${stats.error}`);
    }
  } else {
    warning('Could not retrieve serialization statistics');
  }

  // Step 2: Check user auth status
  log('\n🔍 Step 2: Checking user auth status...', 'yellow');
  const authStatus = await getAuthStatus(USERNAME);
  
  if (authStatus) {
    log(`Auth Status for ${USERNAME}:`, 'blue');
    log(`  • Has Valid Auth: ${authStatus.hasValidAuth ? '✅' : '❌'}`);
    log(`  • Is Active: ${authStatus.isActive ? '✅' : '❌'}`);
    log(`  • Is Connected: ${authStatus.isConnected ? '✅' : '❌'}`);
    log(`  • Can Activate Without QR: ${authStatus.canActivateWithoutQR ? '✅' : '❌'}`);
    
    if (!authStatus.hasValidAuth) {
      warning('No valid auth data found. Serialization test may be limited.');
    }
  }

  // Step 3: Get user-specific serialization metrics
  log('\n📈 Step 3: Getting user-specific serialization metrics...', 'yellow');
  const metrics = await getSerializationMetrics(USERNAME);
  
  if (metrics && metrics.originalSize) {
    log(`Serialization Metrics for ${USERNAME}:`, 'blue');
    log(`  • Original Size: ${formatBytes(metrics.originalSize)}`);
    log(`  • Compressed Size: ${formatBytes(metrics.compressedSize)}`);
    log(`  • Compression Ratio: ${metrics.compressionRatio.toFixed(2)}x`);
    log(`  • Serialization Time: ${metrics.serializationTime}ms`);
    log(`  • Deserialization Time: ${metrics.deserializationTime}ms`);
    log(`  • Checksum Valid: ${metrics.checksumValid ? '✅' : '❌'}`);
    
    // Calculate space savings
    const spaceSaved = metrics.originalSize - metrics.compressedSize;
    const spaceSavedPercent = (spaceSaved / metrics.originalSize * 100).toFixed(2);
    log(`  • Space Saved: ${formatBytes(spaceSaved)} (${spaceSavedPercent}%)`);
  } else {
    warning(`No serialization metrics available for ${USERNAME}`);
    if (metrics && metrics.message) {
      log(`  Message: ${metrics.message}`);
    }
  }

  // Step 4: Validate serialization integrity
  log('\n🔒 Step 4: Validating serialization integrity...', 'yellow');
  const validation = await validateSerializationIntegrity(USERNAME);
  
  if (validation) {
    log(`Integrity Validation for ${USERNAME}:`, 'blue');
    log(`  • Valid: ${validation.valid ? '✅' : '❌'}`);
    
    if (validation.issues && validation.issues.length > 0) {
      log('  • Issues Found:');
      validation.issues.forEach(issue => {
        log(`    - ${issue}`, 'red');
      });
    } else {
      success('  • No integrity issues found');
    }
    
    if (validation.metrics) {
      log('  • Validation Metrics Available: ✅');
    }
  } else {
    error('Could not validate serialization integrity');
  }

  // Step 5: Test force save functionality
  log('\n💾 Step 5: Testing force save functionality...', 'yellow');
  const forceSaveResult = await forceSave(USERNAME);
  
  if (forceSaveResult && forceSaveResult.success) {
    success(`Force save completed for ${USERNAME}`);
  } else {
    warning('Force save may have failed or user has no active session');
  }

  // Step 6: Re-check metrics after force save
  log('\n🔄 Step 6: Re-checking metrics after force save...', 'yellow');
  const updatedMetrics = await getSerializationMetrics(USERNAME);
  
  if (updatedMetrics && updatedMetrics.originalSize && metrics && metrics.originalSize) {
    const timeDiff = updatedMetrics.serializationTime - metrics.serializationTime;
    if (Math.abs(timeDiff) > 0) {
      log(`Serialization time changed by ${timeDiff}ms`);
    } else {
      log('Serialization metrics unchanged (expected if no new data)');
    }
  }

  // Final summary
  log('\n🎉 Serialization Test Results:', 'green');
  log('===============================', 'green');
  
  const results = {
    statsAvailable: !!stats,
    userHasAuth: authStatus?.hasValidAuth || false,
    metricsAvailable: !!(metrics && metrics.originalSize),
    integrityValid: validation?.valid || false,
    forceSaveWorked: forceSaveResult?.success || false
  };
  
  log(`✅ System Stats Available: ${results.statsAvailable ? 'PASS' : 'FAIL'}`);
  log(`✅ User Has Auth Data: ${results.userHasAuth ? 'PASS' : 'FAIL'}`);
  log(`✅ Metrics Available: ${results.metricsAvailable ? 'PASS' : 'FAIL'}`);
  log(`✅ Integrity Valid: ${results.integrityValid ? 'PASS' : 'FAIL'}`);
  log(`✅ Force Save Works: ${results.forceSaveWorked ? 'PASS' : 'FAIL'}`);
  
  const passCount = Object.values(results).filter(Boolean).length;
  const totalTests = Object.keys(results).length;
  
  log(`\n📊 Overall Score: ${passCount}/${totalTests} tests passed`);
  
  if (passCount === totalTests) {
    success('🎉 ALL TESTS PASSED! Serialization is working perfectly!');
  } else if (passCount >= totalTests - 1) {
    success('🎉 MOSTLY WORKING! Serialization is functional with minor issues.');
  } else {
    warning('⚠️  SOME ISSUES FOUND. Serialization needs attention.');
  }
  
  log('\n💡 Key Benefits of Advanced Serialization:', 'cyan');
  log('  • Compressed storage saves disk space');
  log('  • Integrity checking prevents corruption');
  log('  • Proper Buffer/Uint8Array handling');
  log('  • Backward compatibility with legacy data');
  log('  • Performance metrics for optimization');
  log('  • Robust error handling and fallbacks');
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
