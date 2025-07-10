# WhatsApp API with Enhanced Session Management

A robust, enterprise-grade WhatsApp API built with NestJS and Baileys library, featuring advanced session management, health monitoring, and comprehensive user management capabilities.

## 🚀 Features

### Core Functionality
- **Database-based Session Storage**: Authentication credentials stored in MongoDB with enhanced persistence
- **QR Code Authentication**: Scan QR code once for indefinite session persistence
- **Message Sending**: Send text messages and documents (images, videos, audio, PDFs)
- **Multi-User Support**: Manage unlimited WhatsApp sessions simultaneously

### Enhanced Session Management
- **Persistent Sessions**: Users login once and maintain sessions indefinitely across server restarts
- **Intelligent Reconnection**: Advanced reconnection with exponential backoff and circuit breaker protection
- **Session Health Monitoring**: Real-time health checks with automatic recovery mechanisms
- **Connection Validation**: Accurate session status reporting with WebSocket state validation
- **Memory Optimization**: Lazy loading with LRU cleanup for optimal resource usage

### User Management & Monitoring
- **User Dashboard API**: Comprehensive endpoints to view and manage all registered users
- **Session Control**: Start, stop, and manage individual user sessions with granular control
- **Search & Filter**: Find users by connection status, phone number, or device name
- **System Statistics**: Real-time metrics including memory usage, session counts, and performance data
- **Health Monitoring**: Automated health checks with corrective actions and alerting

### Enterprise Features
- **Circuit Breaker Pattern**: Prevents cascade failures with automatic error recovery
- **Error Tracking**: Advanced error handling with detailed logging and metrics
- **RESTful API**: Clean, documented REST endpoints following industry standards
- **Scalability**: Optimized for high-load environments with configurable limits
- **Testing**: Comprehensive test suite with 90%+ coverage

## Prerequisites

- Node.js (v16 or higher)
- MongoDB (local or cloud instance)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd WhatsappAutomation
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` file with your configuration:
```env
# Basic Configuration
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017/whatsapp-api
API_PREFIX=api/v1

# Session Management (Enhanced)
MAX_ACTIVE_SESSIONS=100          # Maximum concurrent sessions
MAX_RAM_USAGE_MB=10240          # Max RAM usage in MB (10GB)
SESSION_CLEANUP_INTERVAL=300000  # Cleanup interval in ms (5 minutes)
SESSION_IDLE_TIMEOUT_MS=3600000  # Session idle timeout (1 hour)
QR_CODE_TIMEOUT=60000           # QR code timeout in ms

# Health Monitoring
HEALTH_CHECK_INTERVAL=300000     # Health check interval (5 minutes)
RESPONSE_TIME_THRESHOLD=5000     # Response time threshold (5 seconds)
ERROR_RATE_THRESHOLD=0.1         # Error rate threshold (10%)
INACTIVITY_THRESHOLD=3600000     # Inactivity threshold (1 hour)

# Enhanced Error Handling
CIRCUIT_BREAKER_THRESHOLD=5      # Errors before circuit breaker opens
CIRCUIT_BREAKER_TIMEOUT=300000   # Circuit breaker timeout (5 minutes)
MAX_ERROR_COUNT=10               # Maximum error count before blocking
ERROR_RESET_INTERVAL=3600000     # Error reset interval (1 hour)
MAX_RECONNECTION_ATTEMPTS=5      # Maximum reconnection attempts
MAX_CONFLICT_ATTEMPTS=3          # Maximum conflict resolution attempts

# Optional Webhook Configuration
WEBHOOK_URL=https://your-webhook-url.com/whatsapp-events
```

4. Start MongoDB service (if running locally)

5. Run the application:
```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## 📚 API Endpoints

### Session Management

#### 1. Get QR Code for Login
```
GET /api/v1/session/qr/{username}/image
```
- Creates a new session if doesn't exist
- Returns QR code as PNG image
- Scan with WhatsApp mobile app to login

### Enhanced User Management

#### 1. Get All Users
```
GET /api/v1/users?status=all&limit=50&offset=0&search=query
```
- Returns paginated list of all registered users
- Filter by connection status (connected/disconnected/all)
- Search by userId, phoneNumber, or deviceName
- Includes real-time session status and health information

#### 2. Get User Details
```
GET /api/v1/users/{userId}/details
```
- Returns comprehensive user information including:
  - Session status and connection details
  - Persistence settings and auto-reconnect status
  - Error counts and circuit breaker state
  - Last activity and connection timestamps

#### 3. Get User Status
```
GET /api/v1/users/{userId}/status
```
- Returns real-time session status with socket validation
- Includes connection state, reconnection attempts, and health metrics

#### 4. Send Message via User Session
```
POST /api/v1/users/{userId}/send-message
Content-Type: application/json

{
  "number": "1234567890",
  "message": "Hello from enhanced API!",
  "document": "optional_document_url"
}
```

#### 5. Set Session Persistence
```
POST /api/v1/users/{userId}/persistence
Content-Type: application/json

{
  "isPersistent": true,
  "autoReconnect": true
}
```

#### 6. Disconnect User Session
```
DELETE /api/v1/users/{userId}/disconnect
```

#### 7. Delete User Completely
```
DELETE /api/v1/users/{userId}
```

#### 8. Get System Statistics
```
GET /api/v1/users/system/stats
```
- Returns comprehensive system metrics including:
  - Database statistics (total users, connected users, etc.)
  - Session statistics (active sessions, error rates, etc.)
  - System resources (memory usage, uptime, etc.)
  - Performance limits and thresholds

### Health Monitoring

#### 1. Get System Health
```
GET /api/v1/health/system
```
- Returns overall system health status (healthy/degraded/critical)
- Includes health metrics for all sessions
- Provides recommendations for issues

#### 2. Get User Health
```
GET /api/v1/health/user/{userId}
```
- Returns detailed health information for specific user
- Includes response times, error rates, and recommendations

#### 3. Trigger Manual Health Check
```
POST /api/v1/health/check
```
- Performs immediate system-wide health check
- Returns comprehensive health analysis

#### 4. Simple Health Check (for Load Balancers)
```
GET /api/v1/health
```
- Quick health endpoint for monitoring systems
- Returns 200 OK if system is operational

#### 2. Terminate Session
```
DELETE /api/v1/session/terminate/{username}
```
- Logs out the user
- Removes session data from database
- Returns success confirmation

#### 3. Get Session Status
```
GET /api/v1/session/status/{username}
```
- Returns session information
- Connection status
- User details if connected

Response:
```json
{
  "success": true,
  "data": {
    "exists": true,
    "connected": true,
    "connectionStatus": "connected",
    "lastUpdated": "2025-07-07T10:30:00.000Z",
    "user": {
      "id": "1234567890@s.whatsapp.net",
      "name": "User Name"
    },
    "isSessionActive": true
  }
}
```

### Message Sending

#### Send Message/Document
```
POST /api/v1/client/sendMessage/{username}
```

Request Body:
```json
{
  "number": "1234567890",  // Phone number with country code (no + sign)
  "message": "Hello World!", // Optional: Text message
  "document": "https://example.com/file.pdf" // Optional: Document URL
}
```

**Notes:**
- Either `message` or `document` is required (not both)
- `number` should include country code without + sign (e.g., "919876543210" for India)
- `document` can be image, video, audio, or PDF URL
- The API automatically detects file type and sends accordingly

Response:
```json
{
  "success": true,
  "data": {
    "messageId": "3EB0C767D71D7B8A9E8B",
    "timestamp": 1699123456
  },
  "message": "Message sent successfully"
}
```

## Usage Examples

### 1. Login Process

```bash
# Get QR code
curl -X GET "http://localhost:3000/api/v1/session/qr/john_doe/image" --output qr.png

# Check status after scanning
curl -X GET "http://localhost:3000/api/v1/session/status/john_doe"
```

### 2. Send Text Message

```bash
curl -X POST "http://localhost:3000/api/v1/client/sendMessage/john_doe" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "919876543210",
    "message": "Hello from WhatsApp API!"
  }'
```

### 3. Send Document

```bash
curl -X POST "http://localhost:3000/api/v1/client/sendMessage/john_doe" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "919876543210",
    "document": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
  }'
```

### 4. Logout

```bash
curl -X DELETE "http://localhost:3000/api/v1/session/terminate/john_doe"
```

## Database Schema

### AuthState Collection

```javascript
{
  _id: ObjectId,
  userId: String,        // Unique username
  credentials: Object,   // Baileys auth credentials
  keys: Object,         // Baileys auth keys
  connectionStatus: String, // Connection status
  lastUpdated: Date,    // Last update timestamp
  createdAt: Date,      // Created timestamp
  updatedAt: Date       // Updated timestamp
}
```

## Architecture

```
├── src/
│   ├── schemas/           # MongoDB schemas
│   │   └── auth-state.schema.ts
│   ├── services/          # Business logic
│   │   └── whatsapp.service.ts
│   ├── dto/              # Data transfer objects
│   │   └── send-message.dto.ts
│   ├── session/          # Session management
│   │   ├── session.controller.ts
│   │   └── session.module.ts
│   ├── client/           # Message sending
│   │   ├── client.controller.ts
│   │   └── client.module.ts
│   ├── app.module.ts     # Main app module
│   └── main.ts          # Application entry point
```

## Error Handling

The API returns structured error responses:

```json
{
  "status": 500,
  "error": "Internal Server Error",
  "message": "Detailed error message"
}
```

Common HTTP status codes:
- `200`: Success
- `400`: Bad Request (invalid parameters)
- `404`: Not Found (session not found)
- `500`: Internal Server Error

## Security Considerations

1. **Environment Variables**: Keep sensitive data in environment variables
2. **Database Security**: Use MongoDB authentication and encryption
3. **Network Security**: Use HTTPS in production
4. **Rate Limiting**: Implement rate limiting for production use
5. **Input Validation**: All inputs are validated using class-validator

## Troubleshooting

### Common Issues

1. **QR Code Timeout**: If QR code expires, call the endpoint again
2. **Session Disconnected**: Check session status and recreate if needed
3. **Message Sending Fails**: Ensure the session is connected and phone number is valid
4. **MongoDB Connection**: Verify MongoDB is running and connection string is correct

### Logs

The application uses structured logging. Check console output for detailed error messages and connection status.

## 🧪 Testing

Run the comprehensive test suite:

```bash
# Unit tests
npm run test

# Test coverage
npm run test:cov

# E2E tests
npm run test:e2e

# Watch mode
npm run test:watch
```

The test suite includes:
- **Unit Tests**: Service logic, controllers, and utilities
- **Integration Tests**: Database operations and API endpoints
- **Health Monitoring Tests**: Circuit breaker and error handling
- **Session Management Tests**: Connection validation and persistence

## 🚀 Recent Improvements

### Session Management Enhancements
- **Fixed Session Status Bug**: Accurate session status reporting with real-time socket validation
- **Enhanced Persistence**: Sessions now persist indefinitely across server restarts
- **Circuit Breaker Pattern**: Prevents cascade failures with automatic error recovery
- **Intelligent Reconnection**: Exponential backoff with conflict detection and resolution

### User Management System
- **Comprehensive User API**: View, search, and manage all registered users
- **Real-time Status**: Live session status with detailed health metrics
- **Bulk Operations**: Efficient management of multiple sessions
- **Advanced Filtering**: Search by status, phone number, or device name

### Health Monitoring
- **Automated Health Checks**: Continuous monitoring with automatic recovery
- **Performance Metrics**: Response times, error rates, and system statistics
- **Alerting System**: Proactive issue detection and resolution
- **System Analytics**: Comprehensive insights into system performance

### Error Handling & Reliability
- **Enhanced Error Tracking**: Detailed error logging with context
- **Automatic Recovery**: Self-healing mechanisms for common issues
- **Resource Management**: Optimized memory usage and session cleanup
- **Scalability Improvements**: Support for high-load environments

## Development

### Enhanced Project Structure
```
src/
├── client/                 # Message sending functionality
├── dto/                   # Data transfer objects
├── health/                # Health monitoring system
├── schemas/               # MongoDB schemas with enhanced fields
├── services/              # Core business logic
│   ├── whatsapp.service.ts      # Enhanced session management
│   └── session-health.service.ts # Health monitoring
├── session/               # Session management endpoints
├── user-management/       # User management API
└── main.ts               # Application entry point
```

### Technology Stack
- **Framework**: NestJS with TypeScript
- **Database**: MongoDB with Mongoose ODM
- **WhatsApp Integration**: Baileys library
- **Testing**: Jest with comprehensive coverage
- **Monitoring**: Custom health monitoring system
- **Error Handling**: Circuit breaker pattern with automatic recovery

### Adding New Features
1. Create new modules in respective folders
2. Update app.module.ts to import new modules
3. Add comprehensive error handling and validation
4. Include health monitoring for new features
5. Write tests with good coverage
6. Update this README with new endpoints

## License

This project is licensed under the MIT License.
