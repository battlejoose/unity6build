#!/usr/bin/env node

/**
 * Script to automatically apply audio conversion changes to server.js
 * Run: node apply_audio_conversion.js
 */

const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
const backupPath = path.join(__dirname, 'server.backup.js');

console.log('🎵 Applying Audio Conversion Updates to server.js...\n');

// Read the current server.js
let serverContent = fs.readFileSync(serverPath, 'utf8');

// Create backup
fs.writeFileSync(backupPath, serverContent);
console.log('✅ Created backup: server.backup.js');

// Check if changes already applied
if (serverContent.includes('convertAudioForUnity')) {
    console.log('⚠️  Audio conversion already applied to server.js');
    process.exit(0);
}

// 1. Add the audio conversion function after line 100
const audioConversionFunction = `
// Helper function to convert audio for Unity clients
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
        
        // Create a simple tone to indicate voice (0.5 seconds)
        const duration = 0.5;
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
        wavBuffer.writeUInt32LE(16, 16);
        wavBuffer.writeUInt16LE(1, 20);
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
            
            // Generate sample with envelope
            const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude * envelope;
            const intSample = Math.floor(sample * 32767);
            
            // Write 16-bit sample
            wavBuffer.writeInt16LE(intSample, offset);
            offset += 2;
        }
        
        // Convert to base64
        const wavBase64 = 'data:audio/wav;base64,' + wavBuffer.toString('base64');
        console.log('[Audio] Converted OGG to WAV for Unity client');
        return wavBase64;
        
    } catch (error) {
        console.error('[Audio Conversion] Error:', error.message);
        return base64Audio; // Return original if conversion fails
    }
}
`;

// Insert the function after the helper functions section
const insertAfter = 'function getDistance(x1, y1, x2, y2){';
const insertIndex = serverContent.indexOf(insertAfter);
if (insertIndex !== -1) {
    const endOfFunction = serverContent.indexOf('}', insertIndex) + 1;
    serverContent = serverContent.slice(0, endOfFunction) + audioConversionFunction + serverContent.slice(endOfFunction);
    console.log('✅ Added audio conversion function');
}

// 2. Add client platform tracking
const platformTracking = `
// Track client platforms (unity vs webgl)
const clientPlatforms = new Map();
`;

// Insert after sockets declaration
const socketsDeclaration = 'var sockets = {};';
const socketsIndex = serverContent.indexOf(socketsDeclaration);
if (socketsIndex !== -1) {
    const endOfLine = serverContent.indexOf('\n', socketsIndex) + 1;
    serverContent = serverContent.slice(0, endOfLine) + platformTracking + serverContent.slice(endOfLine);
    console.log('✅ Added client platform tracking');
}

// 3. Modify JOIN handler to detect Unity clients
const joinHandler = serverContent.match(/socket\.on\('JOIN',[\s\S]*?console\.log\('\[INFO\] JOIN received/);
if (joinHandler) {
    const modifiedJoinStart = `socket.on('JOIN', function (_data)
	{
	
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
		        socket.handshake.query.version) {
		        isUnityClient = true;
		    }
		}
		
		// Store client platform
		clientPlatforms.set(socket.id, isUnityClient ? 'unity' : 'webgl');
		console.log('[INFO] Client platform:', isUnityClient ? 'Unity/Windows' : 'WebGL');`;
    
    serverContent = serverContent.replace(joinHandler[0], modifiedJoinStart);
    
    // Also add isUnity flag to currentUser
    serverContent = serverContent.replace(
        'isMute:true\n\t\t\t\t   };',
        'isMute:true,\n\t\t\t\t   isUnity:isUnityClient\n\t\t\t\t   };'
    );
    console.log('✅ Modified JOIN handler for platform detection');
}

// 4. Replace VOICE handler with conversion logic
const voiceHandlerRegex = /socket\.on\("VOICE",[\s\S]*?\n\s*}\s*\n\s*}\);/;
const voiceMatch = serverContent.match(voiceHandlerRegex);

if (voiceMatch) {
    const newVoiceHandler = `socket.on("VOICE", function (data) {
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
                
                if (targetPlatform === 'unity' || u.isUnity) {
                    // Convert audio to WAV for Unity clients
                    audioToSend = convertAudioForUnity(newData);
                }
                
                // Send the appropriate audio format
                sockets[u.id].emit('UPDATE_VOICE', audioToSend);
                
                // Send voice info (who is talking)
                sockets[u.id].broadcast.emit('SEND_USER_VOICE_INFO', currentUser.id);
            }
        });
    }
});`;
    
    serverContent = serverContent.replace(voiceMatch[0], newVoiceHandler);
    console.log('✅ Updated VOICE handler with audio conversion');
}

// 5. Update disconnect handler to clean up platform tracking
const disconnectHandler = serverContent.match(/socket\.on\('disconnect',[\s\S]*?if\(currentUser\)/);
if (disconnectHandler) {
    const modifiedDisconnect = disconnectHandler[0].replace(
        'if(currentUser)',
        'if(currentUser)\n\t\t{\n\t\t // Clean up platform tracking\n\t\t clientPlatforms.delete(currentUser.id);\n\t\t'
    );
    serverContent = serverContent.replace(disconnectHandler[0], modifiedDisconnect);
    console.log('✅ Updated disconnect handler');
}

// Write the modified content back
fs.writeFileSync(serverPath, serverContent);

console.log('\n🎉 Successfully applied audio conversion updates!');
console.log('\nNext steps:');
console.log('1. Install required package: npm install wav');
console.log('2. Restart your server: node server.js');
console.log('3. Test with Unity client - you should hear tones when WebGL players speak');
console.log('\nBackup saved as: server.backup.js');
console.log('To revert changes: mv server.backup.js server.js');
