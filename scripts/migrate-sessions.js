#!/usr/bin/env node

/**
 * Migration Script for WhatsApp Session Persistence
 * This script migrates existing sessions to the new persistence schema
 */

const { MongoClient } = require('mongodb');

// Configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-api';
const DRY_RUN = process.env.DRY_RUN === 'true';

console.log('🔄 WhatsApp Session Migration Script');
console.log(`📊 Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE MIGRATION'}`);
console.log(`🔗 Database: ${MONGODB_URI}`);
console.log('');

async function migrateSessionPersistence() {
  let client;
  
  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    
    const db = client.db();
    const collection = db.collection('auth_states');
    
    console.log('✅ Connected to database');
    
    // Get current session statistics
    const totalSessions = await collection.countDocuments();
    const sessionsWithoutPolicy = await collection.countDocuments({
      persistencePolicy: { $exists: false }
    });
    const temporarySessions = await collection.countDocuments({
      persistencePolicy: 'temporary'
    });
    const persistentSessions = await collection.countDocuments({
      persistencePolicy: 'persistent'
    });
    const permanentSessions = await collection.countDocuments({
      persistencePolicy: 'permanent'
    });
    
    console.log('📊 Current Session Statistics:');
    console.log(`   Total sessions: ${totalSessions}`);
    console.log(`   Without policy: ${sessionsWithoutPolicy}`);
    console.log(`   Temporary: ${temporarySessions}`);
    console.log(`   Persistent: ${persistentSessions}`);
    console.log(`   Permanent: ${permanentSessions}`);
    console.log('');
    
    if (totalSessions === 0) {
      console.log('ℹ️  No sessions found to migrate');
      return;
    }
    
    // Migration operations
    const migrations = [];
    
    // 1. Add missing fields to all sessions
    migrations.push({
      name: 'Add missing persistence fields',
      filter: {
        $or: [
          { persistencePolicy: { $exists: false } },
          { sessionCreated: { $exists: false } },
          { lastActivity: { $exists: false } },
          { priority: { $exists: false } }
        ]
      },
      update: {
        $set: {
          persistencePolicy: 'permanent',
          isPersistent: true,
          autoReconnect: true,
          sessionExpires: null,
          priority: 5,
          tags: [],
          environment: process.env.NODE_ENV || 'production',
          nodeId: process.env.NODE_ID || require('os').hostname(),
          deploymentVersion: process.env.DEPLOYMENT_VERSION || '1.0.0'
        },
        $setOnInsert: {
          sessionCreated: new Date(),
          lastActivity: new Date(),
          totalConnections: 0,
          totalDisconnections: 0,
          errorCount: 0,
          circuitBreakerState: 'closed',
          hasBackup: false,
          isManuallyDisabled: false
        }
      }
    });
    
    // 2. Convert temporary sessions to permanent (if desired)
    if (process.env.CONVERT_TEMPORARY_TO_PERMANENT === 'true') {
      migrations.push({
        name: 'Convert temporary sessions to permanent',
        filter: { persistencePolicy: 'temporary' },
        update: {
          $set: {
            persistencePolicy: 'permanent',
            isPersistent: true,
            sessionExpires: null
          }
        }
      });
    }
    
    // 3. Ensure all connected sessions have recent activity
    migrations.push({
      name: 'Update activity for connected sessions',
      filter: { 
        connectionStatus: 'connected',
        $or: [
          { lastActivity: { $exists: false } },
          { lastActivity: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
        ]
      },
      update: {
        $set: {
          lastActivity: new Date(),
          lastUpdated: new Date()
        }
      }
    });
    
    // Execute migrations
    let totalUpdated = 0;
    
    for (const migration of migrations) {
      console.log(`🔄 ${migration.name}...`);
      
      if (DRY_RUN) {
        const count = await collection.countDocuments(migration.filter);
        console.log(`   Would update ${count} sessions`);
        totalUpdated += count;
      } else {
        const result = await collection.updateMany(migration.filter, migration.update);
        console.log(`   Updated ${result.modifiedCount} sessions`);
        totalUpdated += result.modifiedCount;
      }
    }
    
    console.log('');
    console.log(`✅ Migration completed: ${totalUpdated} sessions ${DRY_RUN ? 'would be' : 'were'} updated`);
    
    // Show final statistics
    if (!DRY_RUN) {
      console.log('');
      console.log('📊 Final Session Statistics:');
      const finalStats = {
        total: await collection.countDocuments(),
        permanent: await collection.countDocuments({ persistencePolicy: 'permanent' }),
        persistent: await collection.countDocuments({ persistencePolicy: 'persistent' }),
        temporary: await collection.countDocuments({ persistencePolicy: 'temporary' }),
        connected: await collection.countDocuments({ connectionStatus: 'connected' }),
        withAutoReconnect: await collection.countDocuments({ autoReconnect: true })
      };
      
      console.log(`   Total sessions: ${finalStats.total}`);
      console.log(`   Permanent: ${finalStats.permanent}`);
      console.log(`   Persistent: ${finalStats.persistent}`);
      console.log(`   Temporary: ${finalStats.temporary}`);
      console.log(`   Connected: ${finalStats.connected}`);
      console.log(`   Auto-reconnect enabled: ${finalStats.withAutoReconnect}`);
    }
    
    console.log('');
    console.log('🎉 Session persistence migration completed successfully!');
    
    if (DRY_RUN) {
      console.log('');
      console.log('💡 To run the actual migration, set DRY_RUN=false');
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log('🔌 Database connection closed');
    }
  }
}

// Run migration
migrateSessionPersistence().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
