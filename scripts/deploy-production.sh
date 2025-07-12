#!/bin/bash

# WhatsApp Session Persistence - Production Deployment Script
# This script deploys the application with session persistence optimizations

set -e

echo "🚀 Starting WhatsApp Session Persistence Production Deployment"

# Configuration
DEPLOYMENT_VERSION=${DEPLOYMENT_VERSION:-"1.0.0"}
NODE_ID=${NODE_ID:-"prod-node-$(hostname)"}
BACKUP_DIR="./backups"
LOG_DIR="./logs"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed"
        exit 1
    fi
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose is not installed"
        exit 1
    fi
    
    # Check Node.js (for local development)
    if ! command -v node &> /dev/null; then
        warning "Node.js is not installed (required for local development only)"
    fi
    
    success "Prerequisites check completed"
}

# Create necessary directories
create_directories() {
    log "Creating necessary directories..."
    
    mkdir -p "$BACKUP_DIR"/{sessions,mongodb}
    mkdir -p "$LOG_DIR"/{app,nginx,mongodb}
    mkdir -p ./mongodb/init-scripts
    mkdir -p ./nginx
    mkdir -p ./monitoring/{prometheus,grafana/{dashboards,datasources}}
    
    success "Directories created"
}

# Set up environment
setup_environment() {
    log "Setting up environment..."
    
    # Copy production environment file
    if [ ! -f .env ]; then
        if [ -f .env.production ]; then
            cp .env.production .env
            log "Copied .env.production to .env"
        else
            error ".env.production file not found"
            exit 1
        fi
    fi
    
    # Update deployment info
    sed -i "s/DEPLOYMENT_VERSION=.*/DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION/" .env
    sed -i "s/NODE_ID=.*/NODE_ID=$NODE_ID/" .env
    
    success "Environment configured"
}

# Build application
build_application() {
    log "Building application..."
    
    # Install dependencies
    if [ -f package.json ]; then
        npm ci --production
        log "Dependencies installed"
    fi
    
    # Build TypeScript
    if [ -f tsconfig.json ]; then
        npm run build
        log "TypeScript compiled"
    fi
    
    # Build Docker image
    docker-compose -f docker-compose.production.yml build
    
    success "Application built"
}

# Initialize database
init_database() {
    log "Initializing database..."
    
    # Start MongoDB first
    docker-compose -f docker-compose.production.yml up -d mongodb
    
    # Wait for MongoDB to be ready
    log "Waiting for MongoDB to be ready..."
    sleep 30
    
    # Create database initialization script
    cat > ./mongodb/init-scripts/01-init-db.js << EOF
// Initialize WhatsApp Session Database
db = db.getSiblingDB('whatsapp-api-prod');

// Create collections with optimized settings
db.createCollection('auth_states', {
    validator: {
        \$jsonSchema: {
            bsonType: "object",
            required: ["userId", "credentials"],
            properties: {
                userId: { bsonType: "string" },
                credentials: { bsonType: "object" },
                persistencePolicy: { 
                    bsonType: "string",
                    enum: ["temporary", "persistent", "permanent"]
                }
            }
        }
    }
});

// Create indexes for optimal performance
db.auth_states.createIndex({ "userId": 1 }, { unique: true });
db.auth_states.createIndex({ "connectionStatus": 1 });
db.auth_states.createIndex({ "lastUpdated": -1 });
db.auth_states.createIndex({ "persistencePolicy": 1 });
db.auth_states.createIndex({ "lastActivity": -1 });
db.auth_states.createIndex({ "phoneNumber": 1 });
db.auth_states.createIndex({ "connectionStatus": 1, "persistencePolicy": 1 });
db.auth_states.createIndex({ "isPersistent": 1, "autoReconnect": 1 });

print("Database initialized successfully");
EOF
    
    success "Database initialization prepared"
}

# Deploy services
deploy_services() {
    log "Deploying services..."
    
    # Stop existing services
    docker-compose -f docker-compose.production.yml down
    
    # Start all services
    docker-compose -f docker-compose.production.yml up -d
    
    success "Services deployed"
}

# Wait for services to be ready
wait_for_services() {
    log "Waiting for services to be ready..."
    
    # Wait for application
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f http://localhost:3000/api/v1/health &> /dev/null; then
            success "Application is ready"
            break
        fi
        
        log "Attempt $attempt/$max_attempts - waiting for application..."
        sleep 10
        ((attempt++))
    done
    
    if [ $attempt -gt $max_attempts ]; then
        error "Application failed to start within expected time"
        exit 1
    fi
}

# Run post-deployment tasks
post_deployment() {
    log "Running post-deployment tasks..."
    
    # Migrate all sessions to permanent persistence
    curl -X POST http://localhost:3000/api/v1/session/migrate-to-permanent \
        -H "Content-Type: application/json" || warning "Migration request failed"
    
    # Create initial backup
    curl -X POST http://localhost:3000/api/v1/session/backups/create \
        -H "Content-Type: application/json" \
        -d '{"type":"full"}' || warning "Initial backup failed"
    
    # Execute session policies
    curl -X POST http://localhost:3000/api/v1/session/policies/execute \
        -H "Content-Type: application/json" || warning "Policy execution failed"
    
    success "Post-deployment tasks completed"
}

# Display deployment info
display_info() {
    log "Deployment completed successfully!"
    echo
    echo "📊 Deployment Information:"
    echo "  Version: $DEPLOYMENT_VERSION"
    echo "  Node ID: $NODE_ID"
    echo "  Environment: production"
    echo
    echo "🌐 Service URLs:"
    echo "  Application: http://localhost:3000"
    echo "  Health Check: http://localhost:3000/api/v1/health"
    echo "  System Stats: http://localhost:3000/api/v1/session/system-stats"
    echo
    echo "📁 Important Directories:"
    echo "  Backups: $BACKUP_DIR"
    echo "  Logs: $LOG_DIR"
    echo
    echo "🔧 Management Commands:"
    echo "  View logs: docker-compose -f docker-compose.production.yml logs -f"
    echo "  Stop services: docker-compose -f docker-compose.production.yml down"
    echo "  Restart: docker-compose -f docker-compose.production.yml restart"
    echo
    echo "⚠️  IMPORTANT: Sessions are configured for PERMANENT persistence"
    echo "   They will NOT expire automatically and will survive restarts"
}

# Main deployment flow
main() {
    log "Starting deployment process..."
    
    check_prerequisites
    create_directories
    setup_environment
    build_application
    init_database
    deploy_services
    wait_for_services
    post_deployment
    display_info
    
    success "🎉 Production deployment completed successfully!"
}

# Handle script interruption
trap 'error "Deployment interrupted"; exit 1' INT TERM

# Run main function
main "$@"
