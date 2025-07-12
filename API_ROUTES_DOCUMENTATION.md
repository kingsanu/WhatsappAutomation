# WhatsApp API Routes Documentation

## 📋 Complete API Endpoints Reference

### 🔐 **Session Management**

#### **QR Code & Session Creation**
```http
GET /api/v1/session/qr/:username
```
- **Description**: Generate QR code for new session
- **Response**: QR code data for scanning

```http
GET /api/v1/session/status/:username
```
- **Description**: Get session connection status
- **Response**: Connection status, user info, last activity

```http
POST /api/v1/session/activate/:username
```
- **Description**: Activate session using existing auth (NO QR REQUIRED)
- **Response**: Session activation result

```http
GET /api/v1/session/detailed/:username
```
- **Description**: Get detailed session information
- **Response**: Comprehensive session data and metrics

#### **Session Control**
```http
DELETE /api/v1/session/clear/:username
```
- **Description**: Clear specific user session
- **Response**: Confirmation of session removal

```http
DELETE /api/v1/session/clear-all
```
- **Description**: Clear all active sessions
- **Response**: Count of cleared sessions

```http
POST /api/v1/session/logout/:username
```
- **Description**: Logout user from WhatsApp
- **Response**: Logout confirmation

### 🔧 **Session Persistence**

#### **Persistence Policy Management**
```http
PUT /api/v1/session/persistence/:username
```
- **Body**: `{ "policy": "permanent|persistent|temporary", "autoReconnect": true }`
- **Description**: Set session persistence policy
- **Response**: Updated persistence settings

```http
POST /api/v1/session/migrate-to-permanent
```
- **Description**: Migrate all sessions to permanent persistence
- **Response**: Migration results

#### **Authentication Status**
```http
GET /api/v1/session/auth-status/:username
```
- **Description**: Check if user has valid auth for QR-less activation
- **Response**: Auth validity, connection status, capabilities

### ⚡ **Conflict Resolution**

#### **Conflict Management**
```http
GET /api/v1/session/conflicts
```
- **Description**: List all conflicted sessions
- **Response**: Array of conflicted sessions with details

```http
POST /api/v1/session/conflicts/:username/resolve
```
- **Description**: Resolve conflict while preserving auth data
- **Response**: Resolution result with next steps

```http
POST /api/v1/session/conflicts/:username/force-takeover
```
- **Body**: `{ "completeReset": false }`
- **Description**: Force session takeover (preserves auth by default)
- **Response**: Takeover result

```http
DELETE /api/v1/session/conflicts/:username
```
- **Description**: Clear conflict state only
- **Response**: Confirmation

```http
DELETE /api/v1/session/clear-conflicts
```
- **Description**: Clear all conflicted sessions
- **Response**: Count of cleared conflicts

### 📊 **System Monitoring**

#### **System Statistics**
```http
GET /api/v1/session/system-stats
```
- **Description**: Get comprehensive system statistics
- **Response**: Memory usage, session counts, performance metrics

```http
GET /api/v1/session/health/system
```
- **Description**: Get system health overview
- **Response**: Health metrics, alerts, trends

```http
GET /api/v1/session/health/:username
```
- **Description**: Get user-specific health metrics
- **Response**: User health data

### 🔍 **Serialization & Data Integrity**

#### **Serialization Management**
```http
GET /api/v1/session/serialization/stats
```
- **Description**: Get serialization system statistics
- **Response**: Compression ratios, performance metrics, space savings

```http
GET /api/v1/session/serialization/metrics/:username
```
- **Description**: Get user-specific serialization metrics
- **Response**: Compression data, timing, integrity status

```http
GET /api/v1/session/serialization/validate/:username
```
- **Description**: Validate serialization integrity for user
- **Response**: Validation results, issues, metrics

```http
POST /api/v1/session/serialization/force-save/:username
```
- **Description**: Force save serialization data
- **Response**: Save confirmation

### 📋 **Policy Management**

#### **Session Policies**
```http
GET /api/v1/session/policies
```
- **Description**: Get all policy rules and statistics
- **Response**: Policy rules, execution stats

```http
PUT /api/v1/session/policies/:ruleId/enable
```
- **Description**: Enable specific policy rule
- **Response**: Enable confirmation

```http
PUT /api/v1/session/policies/:ruleId/disable
```
- **Description**: Disable specific policy rule
- **Response**: Disable confirmation

```http
POST /api/v1/session/policies/execute
```
- **Description**: Force execute all policies
- **Response**: Execution results

### 💾 **Backup & Recovery**

#### **Session Backups**
```http
GET /api/v1/session/backups
```
- **Description**: List all session backups
- **Response**: Backup history and statistics

```http
POST /api/v1/session/backups/create
```
- **Body**: `{ "type": "full|incremental" }`
- **Description**: Create session backup
- **Response**: Backup creation result

```http
GET /api/v1/session/backups/:backupId
```
- **Description**: Get specific backup information
- **Response**: Backup details and metadata

```http
POST /api/v1/session/backups/:backupId/restore
```
- **Body**: `{ "overwriteExisting": false, "onlyMissingSessions": true, "dryRun": false }`
- **Description**: Restore sessions from backup
- **Response**: Restoration results

### 📱 **Message Operations**

#### **Send Messages**
```http
POST /api/v1/message/send
```
- **Body**: `{ "userId": "username", "to": "phone_number", "message": "text" }`
- **Description**: Send text message
- **Response**: Message delivery status

```http
POST /api/v1/message/send-media
```
- **Body**: `{ "userId": "username", "to": "phone_number", "media": "base64_data", "type": "image|video|audio|document" }`
- **Description**: Send media message
- **Response**: Media delivery status

#### **Message History**
```http
GET /api/v1/message/history/:username
```
- **Query**: `?limit=50&offset=0`
- **Description**: Get message history for user
- **Response**: Array of messages with metadata

### 👥 **User Management**

#### **User Operations**
```http
GET /api/v1/users
```
- **Description**: List all users
- **Response**: Array of user data

```http
GET /api/v1/users/:userId
```
- **Description**: Get specific user information
- **Response**: User details and session status

```http
PUT /api/v1/users/:userId/persistence
```
- **Body**: `{ "policy": "permanent", "autoReconnect": true }`
- **Description**: Set user persistence policy
- **Response**: Updated user settings

```http
DELETE /api/v1/users/:userId
```
- **Description**: Delete user and associated data
- **Response**: Deletion confirmation

### 🔧 **System Health**

#### **Health Checks**
```http
GET /api/v1/health
```
- **Description**: Basic health check
- **Response**: System status

```http
GET /api/v1/health/detailed
```
- **Description**: Detailed health information
- **Response**: Comprehensive system health data

### 📈 **Analytics & Metrics**

#### **Performance Metrics**
```http
GET /api/v1/metrics/performance
```
- **Description**: Get performance metrics
- **Response**: CPU, memory, response times

```http
GET /api/v1/metrics/sessions
```
- **Description**: Get session-specific metrics
- **Response**: Session statistics and trends

## 🔑 **Authentication**

Most endpoints require authentication. Include API key in headers:
```http
Authorization: Bearer YOUR_API_KEY
```

## 📝 **Response Format**

All endpoints return responses in this format:
```json
{
  "success": true|false,
  "message": "Description of result",
  "data": { /* Response data */ },
  "error": "Error message (if success=false)"
}
```

## 🚀 **Quick Start Examples**

### **Create and Activate Session**
```bash
# 1. Generate QR code
curl http://localhost:3000/api/v1/session/qr/username

# 2. Check status after scanning
curl http://localhost:3000/api/v1/session/status/username

# 3. Send message
curl -X POST http://localhost:3000/api/v1/message/send \
  -H "Content-Type: application/json" \
  -d '{"userId":"username","to":"1234567890","message":"Hello!"}'
```

### **Resolve Conflicts**
```bash
# 1. Check conflicts
curl http://localhost:3000/api/v1/session/conflicts

# 2. Resolve conflict (preserves auth)
curl -X POST http://localhost:3000/api/v1/session/conflicts/username/resolve

# 3. Activate without QR
curl -X POST http://localhost:3000/api/v1/session/activate/username
```

### **Monitor System**
```bash
# System stats
curl http://localhost:3000/api/v1/session/system-stats

# Serialization stats
curl http://localhost:3000/api/v1/session/serialization/stats

# Health check
curl http://localhost:3000/api/v1/session/health/system
```

---

**🎉 Complete API with session persistence, conflict resolution, and advanced monitoring!**
