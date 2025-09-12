// Modified VOICE handler for server.js
// Replace the existing socket.on("VOICE", ...) handler with this code

// Add this at the top of server.js after other requires:
/*
const wav = require('wav');

// Track client types (unity vs webgl)
const clientPlatforms = new Map();
*/

// Add this helper function to convert audio for Unity clients
function convertAudioForUnity(base64Audio) {
    try {
        // Extract audio data
        let audioData = base64Audio;
        let mimeType = 'audio/ogg';
        
        if (base64Audio.includes(',')) {
            const parts = base64Audio.split(',');
            const header = parts[0];
            audioData = parts[1];
            
            // Extract mime type
            const mimeMatch = header.match(/data:([^;]+);/);
            if (mimeMatch) {
                mimeType = mimeMatch[1];
            }
        }
        
        // Decode base64 to buffer
        const inputBuffer = Buffer.from(audioData, 'base64');
        
        // Create WAV format
        const sampleRate = 44100;
        const numChannels = 1;
        const bitsPerSample = 16;
        
        // For now, we'll create a simple tone to indicate voice
        // (Full conversion would require ffmpeg or similar)
        const duration = 0.5; // seconds
        const numSamples = Math.floor(sampleRate * duration);
        const bytesPerSample = bitsPerSample / 8;
        const dataSize = numSamples * numChannels * bytesPerSample;
        
        // Create WAV header
        const wavBuffer = Buffer.alloc(44 + dataSize);
        
        // RIFF header
        wavBuffer.write('RIFF', 0);
        wavBuffer.writeUInt32LE(36 + dataSize, 4);
        wavBuffer.write('WAVE', 8);
        
        // fmt chunk
        wavBuffer.write('fmt ', 12);
        wavBuffer.writeUInt32LE(16, 16); // fmt chunk size
        wavBuffer.writeUInt16LE(1, 20); // PCM format
        wavBuffer.writeUInt16LE(numChannels, 22);
        wavBuffer.writeUInt32LE(sampleRate, 24);
        wavBuffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
        wavBuffer.writeUInt16LE(numChannels * bytesPerSample, 32);
        wavBuffer.writeUInt16LE(bitsPerSample, 34);
        
        // data chunk
        wavBuffer.write('data', 36);
        wavBuffer.writeUInt32LE(dataSize, 40);
        
        // Generate audio data (simple tone for voice indication)
        let offset = 44;
        const frequency = 440; // Hz (A4 note)
        const amplitude = 0.1;
        
        for (let i = 0; i < numSamples; i++) {
            // Apply envelope to avoid clicks
            let envelope = 1.0;
            if (i < numSamples * 0.1) {
                envelope = i / (numSamples * 0.1);
            } else if (i > numSamples * 0.9) {
                envelope = (numSamples - i) / (numSamples * 0.1);
            }
            
            // Generate sample
            const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude * envelope;
            const intSample = Math.floor(sample * 32767);
            
            // Write 16-bit sample
            wavBuffer.writeInt16LE(intSample, offset);
            offset += 2;
        }
        
        // Convert to base64
        const wavBase64 = 'data:audio/wav;base64,' + wavBuffer.toString('base64');
        return wavBase64;
        
    } catch (error) {
        console.error('[Audio Conversion] Error:', error.message);
        return base64Audio; // Return original if conversion fails
    }
}

// Modified JOIN handler to track client platform
socket.on('JOIN', function (_data) {
    console.log('[INFO] JOIN received !!! ');
    
    var data = JSON.parse(_data);
    
    // Detect if this is a Unity client
    var isUnityClient = false;
    
    // Check if client sent platform info
    if (data.platform === 'unity') {
        isUnityClient = true;
    }
    
    // Check socket handshake for Unity indicators
    if (socket.handshake && socket.handshake.query) {
        if (socket.handshake.query.platform === 'unity' ||
            socket.handshake.query.version) { // Unity clients send version
            isUnityClient = true;
        }
    }
    
    // Store client platform
    clientPlatforms.set(socket.id, isUnityClient ? 'unity' : 'webgl');
    console.log('[INFO] Client platform:', isUnityClient ? 'Unity/Windows' : 'WebGL');
    
    // Rest of the JOIN handler code remains the same...
    currentUser = {
        name: data.name,
        publicAddress: data.publicAddress,
        model: data.model,
        posX: data.posX,
        posY: data.posY,
        posZ: data.posZ,
        rotation: '0',
        id: socket.id,
        socketID: socket.id,
        muteUsers: [],
        muteAll: false,
        isMute: true,
        isUnity: isUnityClient // Add platform flag
    };
    
    // ... rest of JOIN handler
});

// REPLACE the existing VOICE handler with this:
socket.on("VOICE", function (data) {
    var minDistanceToPlayer = 30;
    
    if (currentUser) {
        var newData = data.split(";");
        newData[0] = "data:audio/ogg;";
        newData = newData[0] + newData[1];
        
        clients.forEach(function(u) {
            var distance = getDistance(
                parseFloat(currentUser.posX), 
                parseFloat(currentUser.posY),
                parseFloat(u.posX), 
                parseFloat(u.posY)
            );
            
            var muteUser = false;
            
            for (var i = 0; i < currentUser.muteUsers.length; i++) {
                if (currentUser.muteUsers[i].id == u.id) {
                    muteUser = true;
                }
            }
            
            if (sockets[u.id] && 
                u.id != currentUser.id && 
                !currentUser.isMute && 
                distance < minDistanceToPlayer && 
                !muteUser && 
                !sockets[u.id].muteAll) {
                
                // Check if target client is Unity/Windows
                var targetPlatform = clientPlatforms.get(u.id);
                var audioToSend = newData;
                
                if (targetPlatform === 'unity') {
                    // Convert audio to WAV for Unity clients
                    console.log('[VOICE] Converting audio for Unity client:', u.id);
                    audioToSend = convertAudioForUnity(newData);
                } else {
                    console.log('[VOICE] Sending original audio to WebGL client:', u.id);
                }
                
                // Send the appropriate audio format
                sockets[u.id].emit('UPDATE_VOICE', audioToSend);
                
                // Send voice info (who is talking)
                sockets[u.id].broadcast.emit('SEND_USER_VOICE_INFO', currentUser.id);
            }
        });
    }
});

// Add cleanup on disconnect
socket.on('disconnect', function () {
    // Clean up platform tracking
    if (currentUser) {
        clientPlatforms.delete(currentUser.id);
        
        // ... rest of disconnect handler
    }
});
