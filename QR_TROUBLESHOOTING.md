# QR Code Troubleshooting Guide

## 🔍 **Common QR Code Issues & Solutions**

### **Issue: "qr code not ready or already scanned"**

This error occurs when the QR code generation process encounters problems. Here are the solutions:

## 🚀 **Quick Fixes**

### **1. Basic Troubleshooting Steps**

```bash
# Step 1: Check session status
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/status/YOUR_SESSION_ID

# Step 2: If session exists but no QR, restart it
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/restart/YOUR_SESSION_ID

# Step 3: Wait 10 seconds, then request QR
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/qr/YOUR_SESSION_ID

# Step 4: If still no QR, force regeneration
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/regenerateQr/YOUR_SESSION_ID
```

### **2. New Improved QR Endpoints**

The updated system now provides better QR handling:

- **`GET /session/qr/:sessionId`** - Smart QR retrieval with auto-creation and waiting
- **`GET /session/qr/:sessionId/image`** - QR as PNG image with enhanced error handling  
- **`GET /session/regenerateQr/:sessionId`** - Force QR regeneration (NEW!)

## 📋 **Step-by-Step Solutions**

### **Solution 1: Use the Enhanced QR Endpoint**

The new QR endpoint automatically:
- Creates session if it doesn't exist
- Waits up to 60 seconds for QR generation
- Provides detailed error messages
- Checks session state before generating QR

```bash
# This will now work much better
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/qr/YOUR_SESSION_ID
```

**Expected Response:**
```json
{
  "success": true,
  "qr": "2@ABC123...",
  "message": "QR code ready for scanning"
}
```

### **Solution 2: Force QR Regeneration**

If QR is stuck or expired:

```bash
# Force regenerate QR
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/regenerateQr/YOUR_SESSION_ID

# Wait 10 seconds
sleep 10

# Get new QR
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/qr/YOUR_SESSION_ID
```

### **Solution 3: Complete Session Reset**

For persistent issues:

```bash
# 1. Terminate existing session
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/terminate/YOUR_SESSION_ID

# 2. Wait a moment
sleep 5

# 3. Start fresh session
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/start/YOUR_SESSION_ID

# 4. Wait for initialization
sleep 10

# 5. Get QR code
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/qr/YOUR_SESSION_ID
```

## 🔧 **Advanced Troubleshooting**

### **Check Session Statistics**

```bash
# Get overall session stats
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/stats

# Get all sessions info
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3000/session/all
```

### **Environment Issues**

1. **Chrome/Chromium Problems:**
   ```bash
   # Check if Chrome is accessible
   which google-chrome
   which chromium-browser
   
   # Set Chrome path if needed
   export CHROME_BIN=/usr/bin/google-chrome
   ```

2. **Docker Issues:**
   ```bash
   # Ensure proper Chrome args in Docker
   docker run -e CHROME_BIN="/usr/bin/chromium-browser" your-image
   ```

3. **Memory Issues:**
   ```bash
   # Check available memory
   free -h
   
   # Reduce concurrent sessions if needed
   export MAX_CONCURRENT_SESSIONS=5
   ```

## 📊 **Understanding QR States**

### **Session States:**
- `CONNECTING` - Session initializing, QR should appear soon
- `QR_READY` - QR code generated and ready for scanning
- `AUTHENTICATED` - QR scanned, session connected
- `CONNECTED` - Fully ready for messaging
- `DISCONNECTED` - Session lost, needs restart

### **QR Lifecycle:**
1. Session starts → `CONNECTING`
2. Browser loads → QR generates → `QR_READY`
3. User scans QR → `AUTHENTICATED`
4. WhatsApp connects → `CONNECTED`

## 🛠️ **Configuration Improvements**

Add these to your `.env` for better QR handling:

```env
# Increase timeouts for slow connections
SESSION_HEALTH_CHECK_INTERVAL=60000
SESSION_TIMEOUT=600000

# Enable session persistence
ENABLE_SESSION_PERSISTENCE=TRUE

# Reduce concurrent sessions if having issues
MAX_CONCURRENT_SESSIONS=5

# Enable recovery for failed sessions
RECOVER_SESSIONS=TRUE
```

## 🚨 **Error Messages & Solutions**

| Error Message | Cause | Solution |
|---------------|-------|----------|
| "session_not_found" | Session doesn't exist | Use `/session/start/:id` first |
| "qr code not ready or already scanned" | QR timing issue | Use new enhanced endpoints |
| "Session is already authenticated" | Already connected | Check `/session/status/:id` |
| "QR code generation timeout" | Browser/network issue | Use `/session/regenerateQr/:id` |
| "Maximum concurrent sessions limit reached" | Too many sessions | Terminate unused sessions |

## 📱 **Testing QR Functionality**

Use this test script to verify QR functionality:

```bash
#!/bin/bash
SESSION_ID="test-$(date +%s)"
API_KEY="your_api_key"
BASE_URL="http://localhost:3000"

echo "Testing QR functionality for session: $SESSION_ID"

# Test 1: Get QR (should auto-create session)
echo "1. Getting QR code..."
curl -H "x-api-key: $API_KEY" "$BASE_URL/session/qr/$SESSION_ID"

# Test 2: Get QR as image
echo "2. Getting QR image..."
curl -H "x-api-key: $API_KEY" "$BASE_URL/session/qr/$SESSION_ID/image" -o qr.png

# Test 3: Check session status
echo "3. Checking session status..."
curl -H "x-api-key: $API_KEY" "$BASE_URL/session/status/$SESSION_ID"

# Cleanup
echo "4. Cleaning up..."
curl -H "x-api-key: $API_KEY" "$BASE_URL/session/terminate/$SESSION_ID"
```

## 🎯 **Best Practices**

1. **Always check session status first** before requesting QR
2. **Use the enhanced QR endpoints** for better reliability
3. **Implement retry logic** in your applications
4. **Monitor session health** using the stats endpoint
5. **Set appropriate timeouts** for your use case
6. **Handle different session states** gracefully

## 📞 **Still Having Issues?**

If QR problems persist:

1. **Check server logs** for detailed error messages
2. **Verify WhatsApp Web accessibility** in a regular browser
3. **Test with a simple session ID** (e.g., "test123")
4. **Ensure proper API key** is being used
5. **Check network connectivity** to WhatsApp servers
6. **Verify Chrome/Chromium installation** and permissions

The improved QR system should resolve most common issues. The new endpoints provide better error handling, automatic retries, and detailed troubleshooting information.
