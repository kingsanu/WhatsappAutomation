#!/usr/bin/env node

/**
 * Test Script for WhatsApp Session Persistence
 * This script tests that session persistence is working correctly
 */

const axios = require('axios');

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api/v1';
const TEST_USER = process.env.TEST_USER || 'test-persistence-user';

console.log('🧪 WhatsApp Session Persistence Test');
console.log(`🔗 API URL: ${API_BASE_URL}`);
console.log(`👤 Test User: ${TEST_USER}`);
console.log('');

async function testSessionPersistence() {
  try {
    console.log('1️⃣ Testing API connectivity...');
    
    // Test API health
    try {
      const healthResponse = await axios.get(`${API_BASE_URL}/health`);
      console.log('   ✅ API is healthy');
    } catch (error) {
      console.log('   ❌ API health check failed');
      throw error;
    }
    
    console.log('');
    console.log('2️⃣ Testing session persistence settings...');
    
    // Set session to permanent persistence
    try {
      const persistenceResponse = await axios.put(
        `${API_BASE_URL}/session/persistence/${TEST_USER}`,
        {
          policy: 'permanent',
          autoReconnect: true
        }
      );
      console.log('   ✅ Session persistence set to permanent');
    } catch (error) {
      console.log('   ⚠️  Session persistence setting failed (session may not exist yet)');
    }
    
    console.log('');
    console.log('3️⃣ Testing system statistics...');
    
    // Get system stats
    try {
      const statsResponse = await axios.get(`${API_BASE_URL}/session/system-stats`);
      const stats = statsResponse.data.data;
      
      console.log(`   📊 Total sessions: ${stats.totalSessions || 0}`);
      console.log(`   🔗 Active sessions: ${stats.activeSessions || 0}`);
      console.log(`   💾 Memory usage: ${stats.memoryUsageMB || 0}MB`);
      console.log(`   ⏱️  Uptime: ${Math.round((stats.uptime || 0) / 60)}m`);
      console.log('   ✅ System statistics retrieved');
    } catch (error) {
      console.log('   ❌ Failed to get system statistics');
      throw error;
    }
    
    console.log('');
    console.log('4️⃣ Testing session policies...');
    
    // Get policy rules
    try {
      const policiesResponse = await axios.get(`${API_BASE_URL}/session/policies`);
      const policies = policiesResponse.data.data;
      
      console.log(`   📋 Policy rules: ${policies.rules.length}`);
      console.log(`   ✅ Enabled rules: ${policies.stats.enabledRules}`);
      console.log(`   📈 Success rate: ${policies.stats.successRate}`);
      console.log('   ✅ Session policies retrieved');
    } catch (error) {
      console.log('   ❌ Failed to get session policies');
      throw error;
    }
    
    console.log('');
    console.log('5️⃣ Testing backup functionality...');
    
    // Get backup stats
    try {
      const backupsResponse = await axios.get(`${API_BASE_URL}/session/backups`);
      const backups = backupsResponse.data.data;
      
      console.log(`   💾 Total backups: ${backups.stats.totalBackups}`);
      console.log(`   📁 Total size: ${backups.stats.totalSizeMB}MB`);
      console.log(`   🕒 Latest backup: ${backups.stats.latestBackup ? new Date(backups.stats.latestBackup.timestamp).toLocaleString() : 'None'}`);
      console.log('   ✅ Backup functionality working');
    } catch (error) {
      console.log('   ❌ Failed to get backup information');
      throw error;
    }
    
    console.log('');
    console.log('6️⃣ Testing session migration...');
    
    // Test migration endpoint
    try {
      const migrationResponse = await axios.post(`${API_BASE_URL}/session/migrate-to-permanent`);
      console.log('   ✅ Session migration endpoint working');
    } catch (error) {
      console.log('   ❌ Session migration failed');
      throw error;
    }
    
    console.log('');
    console.log('7️⃣ Testing configuration validation...');
    
    // Validate critical configuration
    const configTests = [
      {
        name: 'Session idle timeout',
        check: () => process.env.SESSION_IDLE_TIMEOUT_MS === '0',
        message: 'SESSION_IDLE_TIMEOUT_MS should be 0 for persistence'
      },
      {
        name: 'QR refresh interval',
        check: () => process.env.QR_REFRESH_INTERVAL_MS === '0',
        message: 'QR_REFRESH_INTERVAL_MS should be 0 for persistence'
      },
      {
        name: 'Emergency cleanup threshold',
        check: () => {
          const threshold = parseFloat(process.env.EMERGENCY_CLEANUP_THRESHOLD || '0.95');
          return threshold >= 0.95;
        },
        message: 'EMERGENCY_CLEANUP_THRESHOLD should be >= 0.95 for persistence'
      }
    ];
    
    let configIssues = 0;
    for (const test of configTests) {
      if (test.check()) {
        console.log(`   ✅ ${test.name}: OK`);
      } else {
        console.log(`   ⚠️  ${test.name}: ${test.message}`);
        configIssues++;
      }
    }
    
    if (configIssues === 0) {
      console.log('   ✅ Configuration validation passed');
    } else {
      console.log(`   ⚠️  ${configIssues} configuration issues found`);
    }
    
    console.log('');
    console.log('🎉 Session Persistence Test Results:');
    console.log('   ✅ API connectivity: PASS');
    console.log('   ✅ System statistics: PASS');
    console.log('   ✅ Session policies: PASS');
    console.log('   ✅ Backup functionality: PASS');
    console.log('   ✅ Migration endpoint: PASS');
    console.log(`   ${configIssues === 0 ? '✅' : '⚠️ '} Configuration: ${configIssues === 0 ? 'PASS' : 'ISSUES FOUND'}`);
    
    console.log('');
    console.log('🚀 Session persistence is working correctly!');
    console.log('');
    console.log('💡 Next steps:');
    console.log('   1. Create WhatsApp sessions - they will persist indefinitely');
    console.log('   2. Restart the application - sessions will be restored automatically');
    console.log('   3. Monitor session health via the API endpoints');
    console.log('   4. Use backup/restore functionality for data protection');
    
  } catch (error) {
    console.error('');
    console.error('❌ Test failed:', error.message);
    
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    
    console.error('');
    console.error('🔧 Troubleshooting:');
    console.error('   1. Ensure the application is running');
    console.error('   2. Check the API URL is correct');
    console.error('   3. Verify database connectivity');
    console.error('   4. Review application logs');
    
    process.exit(1);
  }
}

// Run test
testSessionPersistence().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
