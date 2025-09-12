// Audio conversion utilities for Unity/Windows clients
// Add this to your server.js or include it as a module

const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');

// Store client types (WebGL vs Unity)
const clientTypes = new Map();

// Function to detect client type from connection
function detectClientType(socket, joinData) {
    // Check if it's a Unity client (Windows build)
    // Unity clients will have a specific identifier
    if (socket.handshake && socket.handshake.query) {
        if (socket.handshake.query.platform === 'unity' || 
            socket.handshake.query.clientType === 'standalone') {
            return 'unity';
        }
    }
    
    // Check user agent for Unity
    const userAgent = socket.handshake?.headers?.['user-agent'] || '';
    if (userAgent.includes('Unity')) {
        return 'unity';
    }
    
    // Check if the join data indicates Unity (from SocketIOUnity)
    if (typeof joinData === 'object' && joinData.platform === 'unity') {
        return 'unity';
    }
    
    // Default to WebGL
    return 'webgl';
}

// Convert OGG/WebM audio to WAV for Unity clients
async function convertAudioToWav(base64Audio) {
    return new Promise((resolve, reject) => {
        try {
            // Extract the audio data from base64
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
            
            // Create a readable stream from buffer
            const inputStream = new stream.Readable();
            inputStream.push(inputBuffer);
            inputStream.push(null);
            
            // Output buffer for WAV
            const chunks = [];
            
            // Use ffmpeg to convert to WAV
            ffmpeg(inputStream)
                .inputFormat(mimeType.includes('webm') ? 'webm' : 'ogg')
                .audioCodec('pcm_s16le')
                .audioFrequency(44100)
                .audioChannels(1)
                .format('wav')
                .on('error', (err) => {
                    console.error('[Audio Conversion] Error:', err.message);
                    // Return original if conversion fails
                    resolve(base64Audio);
                })
                .on('end', () => {
                    const wavBuffer = Buffer.concat(chunks);
                    const wavBase64 = 'data:audio/wav;base64,' + wavBuffer.toString('base64');
                    console.log('[Audio Conversion] Successfully converted to WAV');
                    resolve(wavBase64);
                })
                .pipe()
                .on('data', (chunk) => {
                    chunks.push(chunk);
                });
                
        } catch (error) {
            console.error('[Audio Conversion] Failed:', error.message);
            // Return original if conversion fails
            resolve(base64Audio);
        }
    });
}

// Simpler WAV conversion without ffmpeg (fallback)
function convertToSimpleWav(base64Audio) {
    try {
        // Extract audio data
        let audioData = base64Audio;
        if (base64Audio.includes(',')) {
            audioData = base64Audio.split(',')[1];
        }
        
        const inputBuffer = Buffer.from(audioData, 'base64');
        
        // Create a simple WAV header (44 bytes)
        const sampleRate = 44100;
        const numChannels = 1;
        const bitsPerSample = 16;
        const dataSize = inputBuffer.length;
        const fileSize = dataSize + 36;
        
        const wavHeader = Buffer.alloc(44);
        
        // RIFF header
        wavHeader.write('RIFF', 0);
        wavHeader.writeUInt32LE(fileSize, 4);
        wavHeader.write('WAVE', 8);
        
        // fmt chunk
        wavHeader.write('fmt ', 12);
        wavHeader.writeUInt32LE(16, 16); // fmt chunk size
        wavHeader.writeUInt16LE(1, 20); // PCM format
        wavHeader.writeUInt16LE(numChannels, 22);
        wavHeader.writeUInt32LE(sampleRate, 24);
        wavHeader.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // byte rate
        wavHeader.writeUInt16LE(numChannels * bitsPerSample / 8, 32); // block align
        wavHeader.writeUInt16LE(bitsPerSample, 34);
        
        // data chunk
        wavHeader.write('data', 36);
        wavHeader.writeUInt32LE(dataSize, 40);
        
        // Combine header and data
        const wavBuffer = Buffer.concat([wavHeader, inputBuffer]);
        const wavBase64 = 'data:audio/wav;base64,' + wavBuffer.toString('base64');
        
        return wavBase64;
    } catch (error) {
        console.error('[Simple WAV Conversion] Failed:', error.message);
        return base64Audio;
    }
}

// Export functions for use in server.js
module.exports = {
    detectClientType,
    convertAudioToWav,
    convertToSimpleWav,
    clientTypes
};
