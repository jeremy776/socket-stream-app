require('dotenv').config();
const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// Create HTTP server
const httpServer = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Socket.IO Server Running');
  }
});

// Initialize Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL.split(',').map(url => url.trim()),
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Store active connections
const activeStreams = new Map();
const streamViewers = new Map();

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join stream room
  socket.on('join-stream', (streamId) => {
    console.log(`📺 Socket ${socket.id} joining stream: ${streamId}`);
    socket.join(`stream-${streamId}`);

    // Track viewer count
    if (!streamViewers.has(streamId)) {
      streamViewers.set(streamId, new Set());
    }
    streamViewers.get(streamId).add(socket.id);

    // Notify room about viewer count
    const viewerCount = streamViewers.get(streamId).size;
    io.to(`stream-${streamId}`).emit('viewer-count', { streamId, count: viewerCount });
  });

  // Leave stream room
  socket.on('leave-stream', (streamId) => {
    console.log(`👋 Socket ${socket.id} leaving stream: ${streamId}`);
    socket.leave(`stream-${streamId}`);

    // Update viewer count
    if (streamViewers.has(streamId)) {
      streamViewers.get(streamId).delete(socket.id);
      const viewerCount = streamViewers.get(streamId).size;
      io.to(`stream-${streamId}`).emit('viewer-count', { streamId, count: viewerCount });

      // Clean up if no viewers
      if (viewerCount === 0) {
        streamViewers.delete(streamId);
      }
    }
  });

  // Streamer announces stream start
  socket.on('stream-started', ({ streamId, streamerId }) => {
    console.log(`🎬 Stream ${streamId} started by ${streamerId}`);
    activeStreams.set(streamId, { streamerId, startedAt: Date.now() });
    socket.join(`stream-${streamId}`);
    io.emit('stream-list-updated');
  });

  // Streamer announces stream end
  socket.on('stream-ended', ({ streamId }) => {
    console.log(`🛑 Stream ${streamId} ended`);
    activeStreams.delete(streamId);
    io.to(`stream-${streamId}`).emit('stream-ended');
    io.emit('stream-list-updated');
    
    // Clean up viewers
    streamViewers.delete(streamId);
  });

  // Get active streams
  socket.on('get-active-streams', (callback) => {
    const streams = Array.from(activeStreams.entries()).map(([id, data]) => ({
      id,
      ...data,
    }));
    callback(streams);
  });

  // WebRTC Signaling - Streamer sends offer to viewer
  socket.on('offer', ({ streamId, viewerId, offer }) => {
    console.log(`📤 Offer from streamer to viewer ${viewerId} in stream ${streamId}`);
    socket.to(`stream-${streamId}`).emit('offer', { viewerId, offer });
  });

  // WebRTC Signaling - Viewer sends answer to streamer
  socket.on('answer', ({ streamId, viewerId, answer }) => {
    console.log(`📥 Answer from viewer ${viewerId} in stream ${streamId}`);
    socket.to(`stream-${streamId}`).emit('answer', { viewerId, answer });
  });

  // WebRTC Signaling - ICE candidate exchange
  socket.on('ice-candidate', ({ streamId, viewerId, candidate, isStreamer }) => {
    console.log(`🧊 ICE candidate from ${isStreamer ? 'streamer' : 'viewer'} ${viewerId} in stream ${streamId}`);
    socket.to(`stream-${streamId}`).emit('ice-candidate', { viewerId, candidate, isStreamer });
  });

  // Viewer requests stream
  socket.on('request-stream', ({ streamId, viewerId }) => {
    console.log(`🎥 Viewer ${viewerId} requesting stream ${streamId}`);
    socket.to(`stream-${streamId}`).emit('viewer-joined', { viewerId });
  });

  // Chat messages
  socket.on('chat-message', ({ streamId, message }) => {
    console.log(`💬 Chat message in stream ${streamId}:`, message.username);
    io.to(`stream-${streamId}`).emit('chat-message', message);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);

    // Remove from all viewer tracking
    streamViewers.forEach((viewers, streamId) => {
      if (viewers.has(socket.id)) {
        viewers.delete(socket.id);
        const viewerCount = viewers.size;
        io.to(`stream-${streamId}`).emit('viewer-count', { streamId, count: viewerCount });

        if (viewerCount === 0) {
          streamViewers.delete(streamId);
        }
      }
    });

    // Check if this was a streamer
    activeStreams.forEach((data, streamId) => {
      if (data.streamerId === socket.id) {
        console.log(`🛑 Streamer disconnected, ending stream ${streamId}`);
        activeStreams.delete(streamId);
        io.to(`stream-${streamId}`).emit('stream-ended');
        io.emit('stream-list-updated');
      }
    });
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 Socket.IO Server Started          ║
║   📡 Port: ${PORT.toString().padEnd(28)}║
║   🌐 Client URL: ${CLIENT_URL.padEnd(21)}║
║   ✅ Status: Ready                     ║
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  httpServer.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
