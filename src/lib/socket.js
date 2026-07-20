const { Server: SocketIOServer } = require('socket.io');

let io = null;

function initSocket(server) {
  io = new SocketIOServer(server);
  return io;
}

function broadcast(event, data) {
  io.emit(event, data);
}

module.exports = { initSocket, broadcast };
