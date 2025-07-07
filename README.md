# WhatsApp API with Baileys

A robust WhatsApp API built with NestJS and Baileys library that stores authentication credentials in MongoDB for persistent sessions.

## Features

- **Database-based Session Storage**: Authentication credentials stored in MongoDB instead of local files
- **Intelligent Session Management**: Lazy loading with LRU cleanup for optimal memory usage
- **Persistent Sessions**: Users stay logged in across server restarts without QR rescanning
- **Auto-reconnection**: Seamless reconnection for active users
- **QR Code Generation**: Generate QR codes for WhatsApp Web authentication
- **Message Sending**: Send text messages and documents (images, videos, audio, PDFs)
- **Session Management**: Create, terminate, and check session status
- **Memory Efficient**: Only active users consume memory resources
- **Industry Standards**: Built with NestJS, TypeScript, and follows best practices

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
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://localhost:27017/whatsapp-api
WHATSAPP_SESSION_PATH=./sessions
QR_CODE_TIMEOUT=60000
MAX_ACTIVE_SESSIONS=10
SESSION_CLEANUP_INTERVAL=300000
API_PREFIX=api/v1
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

## API Endpoints

### Session Management

#### 1. Get QR Code for Login
```
GET /api/v1/session/qr/{username}/image
```
- Creates a new session if doesn't exist
- Returns QR code as PNG image
- Scan with WhatsApp mobile app to login

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

## Development

### Project Structure
- Built with NestJS framework
- TypeScript for type safety
- MongoDB with Mongoose ODM
- Baileys library for WhatsApp Web integration

### Adding New Features
1. Create new modules in respective folders
2. Update app.module.ts to import new modules
3. Add proper error handling and validation
4. Update this README with new endpoints

## License

This project is licensed under the MIT License.
