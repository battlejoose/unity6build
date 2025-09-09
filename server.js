/*
*@autor: Rio 3D Studios
*@description:  java script server that works as master server of the metaverse from WebGL Multiplayer Kit
*/
var express  = require('express');//import express NodeJS framework module
var app      = express();// create an object of the express module
var http     = require('http').Server(app);// create a http web server using the http library
var io       = require('socket.io')(http);// import socketio communication module
const { v4: uuidv4 } = require('uuid');
var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
const { Pool } = require('pg');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction, getAccount } = require('@solana/spl-token');

const cors=require("cors");
const corsOptions ={
   origin:'*',
   credentials:true,            //access-control-allow-credentials:true
   optionSuccessStatus:200
}

app.use(cors(corsOptions)) // Use this after the variable declaration

app.use("/public/TemplateData",express.static(__dirname + "/public/TemplateData"));
app.use("/public/Build",express.static(__dirname + "/public/Build"));
app.use(express.static(__dirname+'/public'));
app.use(express.json());

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Create post_views table if it doesn't exist
pool.query(`
    CREATE TABLE IF NOT EXISTS post_views (
        post_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        views INTEGER NOT NULL,
        last_scanned TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).catch(err => console.error('[DB] Error creating table:', err));

// Solana configuration
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SERVER_WALLET_PRIVATE_KEY = process.env.SERVER_WALLET_PRIVATE_KEY;
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS; // Your SPL token mint address

let solanaConnection;
let serverKeypair;

// Function to create keypair from private key
function keypairFromPrivateKey(privateKeyString) {
    try {
        console.log('[SOLANA] Creating keypair from private key...');

        // Parse the private key (can be JSON array or base58 string)
        let secretKey;
        if (privateKeyString.startsWith('[')) {
            // JSON array format
            secretKey = new Uint8Array(JSON.parse(privateKeyString));
        } else {
            // Base58 format
            secretKey = bs58.decode(privateKeyString);
        }

        const keypair = Keypair.fromSecretKey(secretKey);
        const address = keypair.publicKey.toString();

        console.log('[SOLANA] ✅ Keypair created successfully from private key');
        console.log('[SOLANA] Wallet address:', address);

        return keypair;
    } catch (error) {
        console.error('[SOLANA] ❌ Failed to create keypair from private key:', error.message);
        throw error;
    }
}

if (SERVER_WALLET_PRIVATE_KEY && TOKEN_MINT_ADDRESS) {
    try {
        solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
        serverKeypair = keypairFromPrivateKey(SERVER_WALLET_PRIVATE_KEY);
        console.log('[SOLANA] Server wallet configured from private key');
        console.log('[SOLANA] Wallet address:', serverKeypair.publicKey.toString());

        // Log server wallet balances on startup
        logServerWalletInfo();
    } catch (err) {
        console.error('[SOLANA] Failed to initialize Solana wallet from private key:', err.message);
    }
} else {
    console.warn('[SOLANA] SERVER_WALLET_PRIVATE_KEY or TOKEN_MINT_ADDRESS not configured');
}


// Function to log server wallet information
async function logServerWalletInfo() {
    try {
        console.log('[SOLANA] 🔍 Checking server wallet balances...');

        // Check SOL balance
        const solBalance = await solanaConnection.getBalance(serverKeypair.publicKey);
        console.log(`[SOLANA] Server wallet SOL balance: ${solBalance / LAMPORTS_PER_SOL} SOL`);

        // Check token balance
        const tokenMintPublicKey = new PublicKey(TOKEN_MINT_ADDRESS);
        const serverTokenAccount = await getAssociatedTokenAddress(tokenMintPublicKey, serverKeypair.publicKey);

        try {
            const tokenBalance = await solanaConnection.getTokenAccountBalance(serverTokenAccount);
            console.log(`[SOLANA] Server wallet token balance: ${tokenBalance.value.uiAmount} ${tokenBalance.value.symbol || 'tokens'}`);
        } catch (error) {
            console.log(`[SOLANA] Server wallet has no tokens of this type`);
            console.log(`[SOLANA] Token account: ${serverTokenAccount.toString()}`);
        }

        console.log(`[SOLANA] Token mint: ${TOKEN_MINT_ADDRESS}`);
        console.log('[SOLANA] ✅ Server wallet is ready for payments!');

    } catch (error) {
        console.error('[SOLANA] Failed to check server wallet balances:', error.message);
    }
}

var clients			= [];// to storage clients
var clientLookup = {};// clients search engine
var sockets = {};//// to storage sockets

var vehicles = [];
var vehicleLookup = {};



// Track tweets that have already been raided to avoid duplicates
var raidedTweetIds = {};

// X (Twitter) API minimal helpers
const X_API_HOST = 'api.x.com';
const X_RECENT_PATH = '/2/tweets/search/recent';
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN;

// OpenAI config
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY || process.env.OPENAI_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CHARACTER_FILE = process.env.CHARACTER_FILE || path.join(__dirname, 'character.txt');
let CHARACTER_PROMPT = '';
try {
    if (fs.existsSync(CHARACTER_FILE)) {
        CHARACTER_PROMPT = fs.readFileSync(CHARACTER_FILE, 'utf8');
    }
} catch (e) {
    CHARACTER_PROMPT = '';
}

// Load usernames for search
let SEARCH_USERNAMES = [];
let usernamesFileFound = false;

function loadUsernamesFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            console.log('[USERNAMES] File found at:', filePath);
            console.log('[USERNAMES] File content length:', fileContent.length);
            const parsed = JSON.parse(fileContent);
            if (Array.isArray(parsed) && parsed.length > 0) {
                SEARCH_USERNAMES = parsed;
                console.log('[USERNAMES] Successfully loaded ' + SEARCH_USERNAMES.length + ' usernames for search');
                console.log('[USERNAMES] First few usernames:', SEARCH_USERNAMES.slice(0, 3).join(', '));
                return true;
            } else {
                console.error('[USERNAMES] File exists but contains invalid or empty array');
                return false;
            }
        }
        return false;
    } catch (e) {
        console.error('[USERNAMES] Error loading file at', filePath, ':', e.message);
        return false;
    }
}

// Try multiple possible paths for the usernames file
const possiblePaths = [
    path.join(__dirname, 'usernames.json'),
    path.join(process.cwd(), 'usernames.json'),
    './usernames.json',
    path.join(__dirname, '..', 'usernames.json'), // Parent directory
    path.join(__dirname, 'public', 'usernames.json') // In public folder
];

console.log('[USERNAMES] Current working directory:', process.cwd());
console.log('[USERNAMES] __dirname:', __dirname);

for (const filePath of possiblePaths) {
    console.log('[USERNAMES] Trying path:', filePath);
    if (loadUsernamesFile(filePath)) {
        usernamesFileFound = true;
        break;
    }
}

if (!usernamesFileFound) {
    console.error('[USERNAMES] Could not find usernames.json in any of the expected locations');
    console.log('[USERNAMES] Tried paths:', possiblePaths);
    try {
        console.log('[USERNAMES] Files in __dirname:', fs.readdirSync(__dirname));
    } catch (e) {
        console.error('[USERNAMES] Could not list directory contents:', e.message);
    }
}

function callOpenAIChat(systemPrompt, userPrompt) {
    return new Promise(function(resolve, reject) {
        if (!OPENAI_API_KEY) {
            return reject(new Error('MISSING_OPENAI_API_KEY'));
        }
        var payload = JSON.stringify({
            model: OPENAI_MODEL,
            temperature: 0.3,
            max_tokens: 64,
            messages: [
                { role: 'system', content: systemPrompt || '' },
                { role: 'user', content: userPrompt || '' }
            ]
        });
        var options = {
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + OPENAI_API_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                try {
                    var json = JSON.parse(data);
                    var text = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ? json.choices[0].message.content.trim() : '';
                    if (!text || text.length === 0) {
                        console.log('[OPENAI] empty content status:', res.statusCode, 'body:', data.substring(0, 256));
                    }
                    resolve(text);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function buildFallbackReply(author, text) {
    // Simple, safe, short default when OpenAI is unavailable
    var snippet = (text || '').replace(/\s+/g,' ').trim();
    if (snippet.length > 120) snippet = snippet.substring(0, 117) + '...';
    return (author ? ('@' + author + ' ') : '') + 'Appreciate the update — thanks for sharing.';
}

// ===== X OAuth 1.0a Sign in (Log in with X) =====
const X_OAUTH1_CONSUMER_KEY = process.env.X_OAUTH1_CONSUMER_KEY || process.env.X_CONSUMER_KEY || '';
const X_OAUTH1_CONSUMER_SECRET = process.env.X_OAUTH1_CONSUMER_SECRET || process.env.X_CONSUMER_SECRET || '';
const APP_BASE_URL = process.env.APP_BASE_URL || '';

var oauthTokenToSecret = {};// oauth_token -> token_secret
var oauthTokenToSocket = {};// oauth_token -> socketId

function percentEncode(str){
    return encodeURIComponent(str).replace(/[!*'()]/g, function(c){return '%'+c.charCodeAt(0).toString(16).toUpperCase();});
}

function buildSignatureBase(method, baseUrl, paramsObj){
    var keys = Object.keys(paramsObj).sort();
    var paramString = keys.map(function(k){ return percentEncode(k)+'='+percentEncode(paramsObj[k]); }).join('&');
    return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
}

function hmacSha1(key, base){
    return crypto.createHmac('sha1', key).update(base).digest('base64');
}

app.get('/x/oauth/callback', function(req, res){
    try{
        var oauth_token = req.query.oauth_token || '';
        var oauth_verifier = req.query.oauth_verifier || '';
        if(!oauth_token || !oauth_verifier){ return res.status(400).send('Missing parameters'); }
        var token_secret = oauthTokenToSecret[oauth_token];
        var socketId = oauthTokenToSocket[oauth_token];
        if(!token_secret){ return res.status(400).send('Unknown token'); }

        var method = 'POST';
        var url = 'https://api.x.com/oauth/access_token';
        var oauthParams = {
            oauth_consumer_key: X_OAUTH1_CONSUMER_KEY,
            oauth_nonce: crypto.randomBytes(16).toString('hex'),
            oauth_signature_method: 'HMAC-SHA1',
            oauth_timestamp: Math.floor(Date.now()/1000).toString(),
            oauth_token: oauth_token,
            oauth_version: '1.0',
            oauth_verifier: oauth_verifier
        };
        var baseParams = Object.assign({}, oauthParams);
        var baseString = buildSignatureBase(method, url, baseParams);
        var signingKey = percentEncode(X_OAUTH1_CONSUMER_SECRET)+'&'+percentEncode(token_secret);
        var signature = hmacSha1(signingKey, baseString);
        oauthParams.oauth_signature = signature;

        var authHeader = 'OAuth ' + Object.keys(oauthParams).filter(function(k){return k!=='oauth_verifier';}).map(function(k){ return percentEncode(k)+'="'+percentEncode(oauthParams[k])+'"';}).join(', ');
        var body = 'oauth_verifier='+percentEncode(oauth_verifier);
        var opt = {
            hostname: 'api.x.com',
            path: '/oauth/access_token',
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
        };
        var rq = https.request(opt, function(rs){
            var buf='';
            rs.on('data', function(c){ buf+=c; });
            rs.on('end', function(){
                try{
                    var parts = {};
                    buf.split('&').forEach(function(p){ var kv=p.split('='); parts[kv[0]]=kv[1]; });
                    var screen_name = decodeURIComponent(parts.screen_name || '');
                    if (socketId && sockets[socketId]) {
                        sockets[socketId].emit('X_AUTH_SUCCESS', { username: screen_name });
                    }
                    res.status(200).send('<html><body>Authorized as @'+screen_name+'. You can close this tab.</body></html>');
                }catch(e){ console.error('[X_OAUTH] access_token parse error', buf); res.status(500).send('Access token parse error'); }
            });
        });
        rq.on('error', function(){ res.status(500).send('Access token request error'); });
        rq.write(body);
        rq.end();
    }catch(e){ res.status(500).send('Callback error'); }
});
function buildXQueryFromKeywords(input) {
	if (!input) return '';
	var core = input
		.split(',')
		.map(function(s) { return s.trim(); })
		.filter(function(s) { return s.length > 0; })
		.map(function(k) { return k.indexOf(' ') >= 0 ? '"' + k + '"' : k; })
		.join(' OR ');
	if (!core) return '';
	return '(' + core + ') -is:retweet -is:reply';
}

function buildXQueryFromUsernames() {
	if (!SEARCH_USERNAMES || SEARCH_USERNAMES.length === 0) return '';

	// Twitter API query limit is 512 characters, leave 20 chars buffer
	const MAX_QUERY_LENGTH = 512 - 20;

	// Shuffle the usernames array to get random selection
	let shuffledUsernames = [...SEARCH_USERNAMES].sort(() => 0.5 - Math.random());
	let selectedUsernames = [];
	let currentQueryLength = 2; // Account for '(' and ')'

	// Keep adding usernames until we're close to the limit
	for (let username of shuffledUsernames) {
		let usernameQuery = 'from:' + username;
		let separatorLength = selectedUsernames.length > 0 ? 4 : 0; // ' OR '
		let newLength = currentQueryLength + usernameQuery.length + separatorLength;

		if (newLength <= MAX_QUERY_LENGTH) {
			selectedUsernames.push(usernameQuery);
			currentQueryLength = newLength;
		} else {
			break; // Stop if adding this username would exceed the limit
		}
	}

	if (selectedUsernames.length === 0) return '';

	var core = selectedUsernames.join(' OR ');
	console.log('[X_SEARCH] Selected ' + selectedUsernames.length + '/' + SEARCH_USERNAMES.length + ' usernames for query (length: ' + currentQueryLength + ' chars)');
	console.log('[X_SEARCH] Selected users: ' + selectedUsernames.slice(0, 5).join(', ') + (selectedUsernames.length > 5 ? '...' : ''));

	return '(' + core + ')';
}

function fetchXRecent(query, nextToken, maxResults) {
	return new Promise(function(resolve, reject) {
		if (!X_BEARER_TOKEN) {
			return reject(new Error('MISSING_X_BEARER_TOKEN'));
		}
		var params = new URLSearchParams({
			query: query,
			max_results: String(maxResults || 100),
			sort_order: 'recency',
			'tweet.fields': 'created_at,public_metrics,author_id,attachments,referenced_tweets',
			expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
			'user.fields': 'username,name,profile_image_url,verified,public_metrics',
			'media.fields': 'url,preview_image_url,type'
		});
		if (nextToken) { params.append('next_token', nextToken); }
		var options = {
			hostname: X_API_HOST,
			path: X_RECENT_PATH + '?' + params.toString(),
			method: 'GET',
			headers: { 'Authorization': 'Bearer ' + X_BEARER_TOKEN }
		};
		var req = https.request(options, function(res) {
			var data = '';
			res.on('data', function(chunk) { data += chunk; });
			res.on('end', function() {
				try {
					var json = JSON.parse(data);
					resolve(json);
				} catch (e) { reject(e); }
			});
		});
		req.on('error', reject);
		req.end();
	});
}

function flattenXResponse(apiResponse) {
	var tweets = apiResponse && apiResponse.data ? apiResponse.data : [];
	var includes = apiResponse && apiResponse.includes ? apiResponse.includes : {};
	var users = includes.users || [];
	var media = includes.media || [];
	var referenced = includes.tweets || [];
	var userById = {};
	users.forEach(function(u) { userById[u.id] = u; });
	var mediaByKey = {};
	media.forEach(function(m) { if (m.media_key) { mediaByKey[m.media_key] = m; } });
	var tweetById = {};
	referenced.forEach(function(rt) { tweetById[rt.id] = rt; });

	// Track posts per author (max 3 per author)
	var authorPostCount = {};
	var resultTweets = [];

	tweets.forEach(function(t) {
		var author = userById[t.author_id] || {};
		var authorUsername = author.username || '';

		// Skip if this author already has 3 posts
		if (authorPostCount[authorUsername] >= 3) {
			return;
		}

		var imageUrl = null;
		if (t.attachments && Array.isArray(t.attachments.media_keys)) {
			for (var i = 0; i < t.attachments.media_keys.length; i++) {
				var key = t.attachments.media_keys[i];
				var m = mediaByKey[key];
				if (m && m.type === 'photo' && (m.url || m.preview_image_url)) {
					imageUrl = m.url || m.preview_image_url;
					break;
				}
			}
		}
		var metrics = t.public_metrics || {};
		// If this is a retweet, use the original tweet's metrics when available
		if (Array.isArray(t.referenced_tweets)) {
			for (var j = 0; j < t.referenced_tweets.length; j++) {
				var ref = t.referenced_tweets[j];
				if (ref && (ref.type === 'retweeted' || ref.type === 'quoted' || ref.type === 'replied_to')) {
					var original = tweetById[ref.id];
					if (original && original.public_metrics) {
						metrics = original.public_metrics;
						break;
					}
				}
			}
		}
		var followers = 0;
		if (author && author.public_metrics && typeof author.public_metrics.followers_count === 'number') {
			followers = author.public_metrics.followers_count;
		}
		var createdMs = t.created_at ? Date.parse(t.created_at) : NaN;
		var ageSeconds = isNaN(createdMs) ? null : Math.floor((Date.now() - createdMs) / 1000);
		var ageText = '';
		if (typeof ageSeconds === 'number' && ageSeconds >= 0) {
			var d = Math.floor(ageSeconds / 86400);
			var h = Math.floor((ageSeconds % 86400) / 3600);
			var m = Math.floor((ageSeconds % 3600) / 60);
			if (d > 0) ageText = d + 'd' + h + 'h' + m + 'm';
			else if (h > 0) ageText = h + 'h' + m + 'm';
			else ageText = Math.max(1, m) + 'm';
		}
		// Filter: only include authors with > 1000 followers
		if (followers <= 1000) {
			return;
		}

		// Increment author post count
		if (!authorPostCount[authorUsername]) {
			authorPostCount[authorUsername] = 0;
		}
		authorPostCount[authorUsername]++;

		resultTweets.push({
			id: t.id,
			text: t.text || '',
			created_at: t.created_at || '',
			author_username: authorUsername,
			author_name: author.name || '',
			author_profile_image_url: author.profile_image_url || '',
			author_verified: !!author.verified,
			followers_count: followers,
			like_count: metrics.like_count || 0,
			reply_count: metrics.reply_count || 0,
			repost_count: metrics.retweet_count || 0,
			quote_count: metrics.quote_count || 0,
			image_url: imageUrl,
			url: authorUsername ? ('https://x.com/' + authorUsername + '/status/' + t.id) : '',
			age_seconds: ageSeconds,
			age_text: ageText
		});
	});

	console.log('[X_SEARCH] Post distribution by author:');
	Object.keys(authorPostCount).forEach(function(username) {
		console.log('[X_SEARCH] @' + username + ': ' + authorPostCount[username] + ' posts');
	});

	return resultTweets;
}

// Helper function to fetch one page of user posts
function fetchUserPostsPage(username, startTime, endTime, nextToken, maxResults) {
	return new Promise(function(resolve, reject) {
		if (!X_BEARER_TOKEN) {
			return reject(new Error('MISSING_X_BEARER_TOKEN'));
		}

		var params = new URLSearchParams({
			query: 'from:' + username,
			start_time: startTime.toISOString(),
			end_time: endTime.toISOString(),
			max_results: maxResults.toString(),
			'tweet.fields': 'created_at,public_metrics,text,author_id',
			expansions: 'author_id',
			'user.fields': 'username,name'
		});

		if (nextToken) {
			params.append('next_token', nextToken);
		}

		var options = {
			hostname: X_API_HOST,
			path: '/2/tweets/search/recent?' + params.toString(),
			method: 'GET',
			headers: { 'Authorization': 'Bearer ' + X_BEARER_TOKEN }
		};

		var req = https.request(options, function(res) {
			var data = '';
			res.on('data', function(chunk) { data += chunk; });
			res.on('end', function() {
				try {
					var json = JSON.parse(data);
					if (json.errors) {
						return reject(new Error('API Error: ' + JSON.stringify(json.errors)));
					}
					resolve(json);
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on('error', reject);
		req.setTimeout(30000, function() { req.destroy(); reject(new Error('Request timeout')); });
		req.end();
	});
}

// Helper function to expand t.co URLs
function expandTcoUrl(shortUrl) {
	return new Promise(function(resolve, reject) {
		if (!shortUrl || !shortUrl.includes('t.co')) {
			resolve(shortUrl);
			return;
		}

		var options = {
			hostname: 't.co',
			path: shortUrl.substring(shortUrl.indexOf('/', 8)), // Get path after t.co/
			method: 'HEAD', // HEAD request to avoid downloading content
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; ClubMoon Scanner)'
			}
		};

		var req = https.request(options, function(res) {
			var expandedUrl = res.headers.location || shortUrl;
			console.log('[URL_EXPAND] ' + shortUrl + ' -> ' + expandedUrl);
			resolve(expandedUrl);
		});

		req.on('error', function(err) {
			console.log('[URL_EXPAND] Error expanding ' + shortUrl + ': ' + err.message);
			resolve(shortUrl); // Return original if expansion fails
		});

		req.setTimeout(5000, function() {
			req.destroy();
			resolve(shortUrl); // Return original if timeout
		});

		req.end();
	});
}

// Helper function to check database for existing post and calculate new views
function checkAndUpdatePostViews(postId, username, currentViews) {
	return new Promise(function(resolve, reject) {
		// First, try to get existing post from database
		pool.query('SELECT views FROM post_views WHERE post_id = $1', [postId])
			.then(function(result) {
				if (result.rows.length > 0) {
					// Post exists in database
					var storedViews = result.rows[0].views;
					console.log('[DB] Post ' + postId + ' exists with ' + storedViews + ' stored views, current views: ' + currentViews);

					if (currentViews > storedViews) {
						// Views increased, update database and return difference
						var viewsDifference = currentViews - storedViews;
						pool.query('UPDATE post_views SET views = $1, last_scanned = CURRENT_TIMESTAMP WHERE post_id = $2', [currentViews, postId])
							.then(function() {
								console.log('[DB] Updated post ' + postId + ' views from ' + storedViews + ' to ' + currentViews + ', new views: ' + viewsDifference);
								resolve(viewsDifference);
							})
							.catch(function(err) {
								console.error('[DB] Error updating post views:', err);
								reject(err);
							});
					} else {
						// No new views
						console.log('[DB] Post ' + postId + ' has no new views (stored: ' + storedViews + ', current: ' + currentViews + ')');
						resolve(0);
					}
				} else {
					// Post doesn't exist, insert it and count all views as new
					console.log('[DB] Post ' + postId + ' not found, inserting with ' + currentViews + ' views');
					pool.query('INSERT INTO post_views (post_id, username, views) VALUES ($1, $2, $3)', [postId, username, currentViews])
						.then(function() {
							console.log('[DB] Inserted new post ' + postId + ' with ' + currentViews + ' views');
							resolve(currentViews);
						})
						.catch(function(err) {
							console.error('[DB] Error inserting post views:', err);
							reject(err);
						});
				}
			})
			.catch(function(err) {
				console.error('[DB] Error checking post views:', err);
				reject(err);
			});
	});
}

// Solana payment function - pays 1 SPL token per new view
async function payForNewViews(recipientWalletAddress, newViewsCount) {
    console.log(`[SOLANA] Starting payment process for ${newViewsCount} tokens to ${recipientWalletAddress}`);

    if (!solanaConnection || !serverKeypair || !TOKEN_MINT_ADDRESS) {
        console.error('[SOLANA] Solana not configured, skipping payment');
        return false;
    }

    if (newViewsCount <= 0) {
        console.log('[SOLANA] No new views to pay for');
        return true;
    }

    try {
        const recipientPublicKey = new PublicKey(recipientWalletAddress);
        const tokenMintPublicKey = new PublicKey(TOKEN_MINT_ADDRESS);

        console.log(`[SOLANA] Server wallet: ${serverKeypair.publicKey.toString()}`);
        console.log(`[SOLANA] Token mint: ${TOKEN_MINT_ADDRESS}`);
        console.log(`[SOLANA] Recipient: ${recipientWalletAddress}`);

        // Check server wallet SOL balance
        const serverBalance = await solanaConnection.getBalance(serverKeypair.publicKey);
        console.log(`[SOLANA] Server wallet SOL balance: ${serverBalance / LAMPORTS_PER_SOL} SOL`);

        // Get the associated token accounts
        const serverTokenAccount = await getAssociatedTokenAddress(tokenMintPublicKey, serverKeypair.publicKey);
        const recipientTokenAccount = await getAssociatedTokenAddress(tokenMintPublicKey, recipientPublicKey);

        console.log(`[SOLANA] Server token account: ${serverTokenAccount.toString()}`);
        console.log(`[SOLANA] Recipient token account: ${recipientTokenAccount.toString()}`);

        // Check server token balance
        try {
            const serverTokenBalance = await solanaConnection.getTokenAccountBalance(serverTokenAccount);
            console.log(`[SOLANA] Server token balance: ${serverTokenBalance.value.uiAmount} tokens`);
        } catch (error) {
            console.log(`[SOLANA] Server token account doesn't exist or has no balance: ${error.message}`);
        }

        const transaction = new Transaction();

        // Check if recipient has an associated token account, create if not
        let recipientAccountExists = false;
        try {
            const accountInfo = await getAccount(solanaConnection, recipientTokenAccount);
            recipientAccountExists = true;
            console.log(`[SOLANA] Recipient token account exists`);
        } catch (error) {
            console.log(`[SOLANA] Recipient token account doesn't exist, will create it`);
            // Account doesn't exist, add instruction to create it
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    serverKeypair.publicKey,
                    recipientTokenAccount,
                    recipientPublicKey,
                    tokenMintPublicKey
                )
            );
        }

        // Get token decimals and calculate proper transfer amount
        const tokenMintInfo = await solanaConnection.getTokenSupply(tokenMintPublicKey);
        const decimals = tokenMintInfo.value.decimals;
        const transferAmount = BigInt(newViewsCount) * BigInt(10 ** decimals); // Convert to smallest unit
        console.log(`[SOLANA] Token has ${decimals} decimals`);
        console.log(`[SOLANA] Transferring ${newViewsCount} tokens = ${transferAmount} base units`);

        transaction.add(
            createTransferInstruction(
                serverTokenAccount,
                recipientTokenAccount,
                serverKeypair.publicKey,
                transferAmount,
                [],
                TOKEN_PROGRAM_ID
            )
        );

        // Get recent blockhash
        const { blockhash } = await solanaConnection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = serverKeypair.publicKey;

        console.log(`[SOLANA] Transaction created with ${transaction.instructions.length} instructions`);
        console.log(`[SOLANA] Sending transaction...`);

        // Send and confirm transaction
        const signature = await sendAndConfirmTransaction(
            solanaConnection,
            transaction,
            [serverKeypair]
        );

        console.log(`[SOLANA] ✅ Payment successful! ${newViewsCount} tokens sent to ${recipientWalletAddress}`);
        console.log(`[SOLANA] Transaction signature: ${signature}`);
        return true;

    } catch (error) {
        console.error('[SOLANA] ❌ Payment failed:', error.message);

        // Try to get more detailed error info
        if (error.logs) {
            console.error('[SOLANA] Transaction logs:', error.logs);
        }

        if (error.transactionError) {
            console.error('[SOLANA] Transaction error details:', error.transactionError);
        }

        return false;
    }
}

// Scan ALL user posts for clubmoon.fun mentions and aggregate NEW view counts within time period
function scanUserPosts(username, daysBack, walletAddress) {
	return new Promise(function(resolve, reject) {
		if (!X_BEARER_TOKEN) {
			return reject(new Error('MISSING_X_BEARER_TOKEN'));
		}

		var endTime = new Date();
		// X API requires end_time to be at least 10 seconds before current time
		endTime.setSeconds(endTime.getSeconds() - 15); // Use 15 seconds to be safe
		var startTime = new Date(endTime.getTime() - (daysBack * 24 * 60 * 60 * 1000));

		console.log('[SCAN_USER_POSTS] Scanning @' + username + ' for last ' + daysBack + ' days (counting NEW clubmoon.fun post views): ' + startTime.toISOString() + ' to ' + endTime.toISOString());

		var allTweets = [];
		var nextToken = null;
		var pageCount = 0;
		var maxPages = 50; // Safety limit to prevent infinite loops (50 pages = 5000 posts max)

		function fetchNextPage() {
			pageCount++;
			if (pageCount > maxPages) {
				console.log('[SCAN_USER_POSTS] Reached maximum page limit (' + maxPages + '), stopping...');
				processResults();
				return;
			}

			fetchUserPostsPage(username, startTime, endTime, nextToken, 100).then(function(json) {
				var tweets = json.data || [];
				var meta = json.meta || {};

				console.log('[SCAN_USER_POSTS] Page ' + pageCount + ': Found ' + tweets.length + ' posts');

				if (tweets.length > 0) {
					allTweets = allTweets.concat(tweets);
				}

				// Check if there's another page
				if (meta.next_token && tweets.length === 100) {
					nextToken = meta.next_token;
					// Add a small delay to avoid rate limiting
					setTimeout(fetchNextPage, 100);
				} else {
					processResults();
				}
			}).catch(function(err) {
				console.error('[SCAN_USER_POSTS] Error fetching page ' + pageCount + ':', err.message);
				processResults(); // Process what we have so far
			});
		}

		function processResults() {
			console.log('[SCAN_USER_POSTS] Processing ' + allTweets.length + ' total posts');

			var totalPosts = allTweets.length;
			var clubMoonPosts = 0;
			var newViews = 0;

			// Process tweets sequentially to avoid overwhelming the URL expansion service
			var processTweet = function(tweetIndex) {
				if (tweetIndex >= allTweets.length) {
					// All tweets processed
					console.log('[SCAN_USER_POSTS] Results: ' + clubMoonPosts + '/' + totalPosts + ' clubmoon.fun posts, ' + newViews + ' NEW views from clubmoon.fun posts');

					// Process payment for new views using server's wallet
					if (newViews > 0 && serverKeypair && walletAddress) {
						console.log('[SCAN_USER_POSTS] Processing payment for ' + newViews + ' new views to ' + walletAddress);
						payForNewViews(walletAddress, newViews).then(paymentSuccess => {
							const result = {
								totalPosts: totalPosts,
								clubMoonPosts: clubMoonPosts,
								newViews: newViews,
								paymentSuccess: paymentSuccess
							};
							if (paymentSuccess) {
								console.log('[SCAN_USER_POSTS] Payment completed successfully');
							} else {
								console.log('[SCAN_USER_POSTS] Payment failed, but scan completed');
							}
							resolve(result);
						}).catch(paymentError => {
							console.error('[SCAN_USER_POSTS] Payment error:', paymentError.message);
							resolve({
								totalPosts: totalPosts,
								clubMoonPosts: clubMoonPosts,
								newViews: newViews,
								paymentSuccess: false,
								paymentError: paymentError.message
							});
						});
					} else {
						// No payment needed or no server wallet configured
						resolve({
							totalPosts: totalPosts,
							clubMoonPosts: clubMoonPosts,
							newViews: newViews,
							paymentSuccess: !serverKeypair ? false : true
						});
					}
					return;
				}

				var tweet = allTweets[tweetIndex];
				var text = tweet.text || '';
				var lowerText = text.toLowerCase();
				var postId = tweet.id;
				var currentViews = tweet.public_metrics && tweet.public_metrics.impression_count ? tweet.public_metrics.impression_count : 0;

				// Debug: Log each post's text to see what we're checking
				console.log('[SCAN_USER_POSTS] Post text: "' + text.substring(0, 100) + (text.length > 100 ? '...' : '') + '"');

				// First check if the text directly contains clubmoon.fun
				var hasClubMoonDirect = lowerText.includes('clubmoon.fun');

				if (hasClubMoonDirect) {
					console.log('[SCAN_USER_POSTS] Contains clubmoon.fun directly: true');
					clubMoonPosts++;

					// Check database for existing post and calculate new views
					checkAndUpdatePostViews(postId, username, currentViews).then(function(viewsToAdd) {
						newViews += viewsToAdd;
						console.log('[SCAN_USER_POSTS] ClubMoon post processed! New views added: ' + viewsToAdd + ', Current total new views: ' + newViews);
						// Process next tweet
						processTweet(tweetIndex + 1);
					}).catch(function(err) {
						console.error('[SCAN_USER_POSTS] Database error for post ' + postId + ':', err.message);
						// Process next tweet even if database fails
						processTweet(tweetIndex + 1);
					});
				} else {
					// Check for t.co URLs and expand them
					var urlRegex = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
					var tcoUrls = text.match(urlRegex);

					if (tcoUrls && tcoUrls.length > 0) {
						console.log('[SCAN_USER_POSTS] Found ' + tcoUrls.length + ' t.co URLs, expanding...');

						// Expand all t.co URLs in this tweet
						var expandPromises = tcoUrls.map(function(url) {
							return expandTcoUrl(url);
						});

						Promise.all(expandPromises).then(function(expandedUrls) {
							var hasClubMoonUrl = expandedUrls.some(function(expandedUrl) {
								return expandedUrl.toLowerCase().includes('clubmoon.fun');
							});

							console.log('[SCAN_USER_POSTS] ClubMoon URL found: ' + hasClubMoonUrl);

							if (hasClubMoonUrl) {
								clubMoonPosts++;

								// Check database for existing post and calculate new views
								checkAndUpdatePostViews(postId, username, currentViews).then(function(viewsToAdd) {
									newViews += viewsToAdd;
									console.log('[SCAN_USER_POSTS] ClubMoon post via URL processed! New views added: ' + viewsToAdd + ', Current total new views: ' + newViews);
									// Process next tweet
									processTweet(tweetIndex + 1);
								}).catch(function(err) {
									console.error('[SCAN_USER_POSTS] Database error for post ' + postId + ':', err.message);
									// Process next tweet even if database fails
									processTweet(tweetIndex + 1);
								});
							} else {
								// Process next tweet
								processTweet(tweetIndex + 1);
							}
						}).catch(function(err) {
							console.log('[SCAN_USER_POSTS] Error expanding URLs: ' + err.message);
							// Process next tweet even if URL expansion fails
							processTweet(tweetIndex + 1);
						});
					} else {
						console.log('[SCAN_USER_POSTS] No clubmoon.fun found');
						// Process next tweet
						processTweet(tweetIndex + 1);
					}
				}
			};

			// Start processing tweets
			processTweet(0);
		}

		// Start fetching the first page
		fetchNextPage();
	});
}

function getDistance(x1, y1, x2, y2){
    let y = x2 - x1;
    let x = y2 - y1;
    
    return Math.sqrt(x * x + y * y);
}


//open a connection with the specific client
io.on('connection', function(socket){

   //print a log in node.js command prompt
  console.log('A user ready for connection!');
  
  //to store current client connection
  var currentUser;
  
  var sended = false;
  
  var muteAll = false;
	
	
	//create a callback fuction to listening EmitPing() method in NetworkMannager.cs unity script
	socket.on('PING', function (_pack)
	{
	  //console.log('_pack# '+_pack);
	  var pack = JSON.parse(_pack);	

	    console.log('message from user# '+socket.id+": "+pack.msg);
        
		 //emit back to NetworkManager in Unity by client.js script
		 socket.emit('PONG', socket.id,pack.msg);
		
	});
	
	//create a callback fuction to listening EmitJoin() method in NetworkMannager.cs unity script
	socket.on('JOIN', function (_data)
	{
	
	    console.log('[INFO] JOIN received !!! ');
		
		var data = JSON.parse(_data);

         // fills out with the information emitted by the player in the unity
        currentUser = {
			       name:data.name,
				   publicAddress: data.publicAddress,
				   model:data.model,
                   posX:data.posX,
				   posY:data.posY,
				   posZ:data.posZ,
				   rotation:'0',
			       id:socket.id,//alternatively we could use socket.id
				   socketID:socket.id,//fills out with the id of the socket that was open
				   muteUsers:[],
				   muteAll:false,
				   isMute:true
				   };//new user  in clients list
					
		console.log('[INFO] player '+currentUser.name+': logged!');
		

		 //add currentUser in clients list
		 clients.push(currentUser);
		 
		 //add client in search engine
		 clientLookup[currentUser.id] = currentUser;
		 
		 sockets[currentUser.id] = socket;//add curent user socket
		 
		 console.log('[INFO] Total players: ' + clients.length);
		 
		 
		 /*********************************************************************************************/		
		
		//send to the client.js script
		socket.emit("JOIN_SUCCESS",currentUser.id,currentUser.name,currentUser.posX,currentUser.posY,currentUser.posZ,data.model);
		
         //spawn all connected clients for currentUser client 
         clients.forEach( function(i) {
		    if(i.id!=currentUser.id)
			{ 
		      //send to the client.js script
		      socket.emit('SPAWN_PLAYER',i.id,i.name,i.posX,i.posY,i.posZ,i.model);
			  
		    }//END_IF
	   
	     });//end_forEach
		
		 // spawn currentUser client on clients in broadcast
		socket.broadcast.emit('SPAWN_PLAYER',currentUser.id,currentUser.name,currentUser.posX,currentUser.posY,currentUser.posZ,data.model);
		
		
	
		
		 
				 

		
  
	});//END_SOCKET_ON
	
	
	
	

	
		
	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('MOVE_AND_ROTATE', function (_data)
	{
	  var data = JSON.parse(_data);	
	  
	  if(currentUser)
	  {
	
       currentUser.posX= data.posX;
	   currentUser.posY = data.posY;
	   currentUser.posZ = data.posZ;
	   
	   currentUser.rotation = data.rotation;
	  
	   // send current user position and  rotation in broadcast to all clients in game
       socket.broadcast.emit('UPDATE_MOVE_AND_ROTATE', currentUser.id,currentUser.posX,currentUser.posY,currentUser.posZ,currentUser.rotation);
	
      
       }
	});//END_SOCKET_ON
	
		
//create a callback fuction to listening EmitAnimation() method in NetworkMannager.cs unity script
	socket.on('ANIMATION', function (_data)
	{
	  var data = JSON.parse(_data);	
	  
	  if(currentUser)
	  {
	   
	   currentUser.timeOut = 0;
	   
	    //send to the client.js script
	   //updates the animation of the player for the other game clients
       socket.broadcast.emit('UPDATE_PLAYER_ANIMATOR', currentUser.id,data.key,data.value,data.type);
	
	   
      }//END_IF
	  
	});//END_SOCKET_ON
	
	
	socket.on('PICK_VEHICLE', function (_data)
	{
		
		var data = JSON.parse(_data);	
		
		 //console.log("data id : "+data.id);
		
		 //spawn all connected clients for currentUser client 
        vehicles.forEach( function(i) {
		    if(i.id==data.id)
			{ 
		      i.currentState = "bussy";
			  i.myClientId = currentUser.id;
			  i.charModel = currentUser.model;
		      //send to the client.js script
			  socket.broadcast.emit('UPDATE_VEHICLE_STATE', currentUser.id,i.id,i.currentState);
			  
		    }//END_IF
	   
	     });//end_forEach
	
    });

   socket.on('RELEASE_VEHICLE', function (_data)
	{
		
		var data = JSON.parse(_data);	
		
		 //spawn all connected clients for currentUser client 
        vehicles.forEach( function(i) {
		    if(i.id==data.vehicleId)
			{ 
		      i.currentState = "available";
			  i.myClientId = '';
			  i.isLocalVehicle = false;
		       //send to the client.js script
			  socket.broadcast.emit('UPDATE_VEHICLE_STATE',  currentUser.id,i.id,i.currentState);
			  
		    }//END_IF
	   
	     });//end_forEach
	
    });
	
	
		
	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('UPDATE_VEHICLE_POS_AND_ROT', function (_data)
	{
	  var data = JSON.parse(_data);	
	  
	 
	  
	
	  
	   vehicles.forEach( function(i) {
		    if(i.id==data.id)
			{ 
			  i.posX= data.posX;
	          i.posY = data.posY;
	          i.posZ = data.posZ;
	          i.rotation = data.rotation;
			  i.spherePosX= data.spherePosX;
	          i.spherePosY = data.spherePosY;
	          i.spherePosZ = data.spherePosZ;
			  
			
			  
			//  socket.broadcast.emit('EMIT_VEHICLE_POS_AND_ROT', i.id,i.posX,i.posY,i.posZ,i.rotation);
			
			  
              clients.forEach(function(u) {

              if(u.id!= currentUser.id)
              {
				   
		        sockets[u.id].emit('EMIT_VEHICLE_POS_AND_ROT', i.id,i.posX,i.posY,i.posZ,i.rotation,i.spherePosX,i.spherePosY,i.spherePosZ);
               }
	  
              });
			  
		    }//END_IF
		});//end_forEach
		
	 
	  
	  
	
	});//END_SOCKET_ON
	
	 socket.on('ACCELERATION', function (_data)
	{
		
		var data = JSON.parse(_data);	
		
		 //spawn all connected clients for currentUser client 
        vehicles.forEach( function(i) {
		    if(i.id==data.id)
			{ 
		      i.acceleration = data.acceleration;
			  
		       //send to the client.js script
			  socket.broadcast.emit('UPDATE_VEHICLE_ACCELERATION',  i.id,i.acceleration);
			  
		    }//END_IF
	   
	     });//end_forEach
	
    });
	
	 socket.on('OFFSPIN', function (_data)
	{
		
		var data = JSON.parse(_data);	
		
		 //spawn all connected clients for currentUser client 
        vehicles.forEach( function(i) {
		    if(i.id==data.id)
			{ 
		      i.offSpin = data.offSpin;
			  
		       //send to the client.js script
			  socket.broadcast.emit('UPDATE_OFFSPIN',  i.id,i.offSpin);
			  
		    }//END_IF
	   
	     });//end_forEach
	
    });
	
	 socket.on('FRONT_WHEELS_ROT', function (_data)
	{
		
		var data = JSON.parse(_data);	
		
		 //spawn all connected clients for currentUser client 
        vehicles.forEach( function(i) {
		    if(i.id==data.id)
			{ 
		      i.wheels_rot = data.wheels_rot;
			  
		       //send to the client.js script
			  socket.broadcast.emit('UPDATE_FRONT_WHEELS_ROT',  i.id, i.wheels_rot);
			  
		    }//END_IF
	   
	     });//end_forEach
	
    });
	
	 socket.on('VEHICLE_INPUTS', function (_data)
	{
		
		var data = JSON.parse(_data);	
		
		 //spawn all connected clients for currentUser client 
        vehicles.forEach( function(i) {
		    if(i.id==data.id)
			{ 
		      
			  
		       //send to the client.js script
			  socket.broadcast.emit('UPDATE_VEHICLE_INPUTS',  i.id, data.h,data.v);
			  
		    }//END_IF
	   
	     });//end_forEach
	
    });

	
	
	
//create a callback fuction to listening EmitGetBestKillers() method in NetworkMannager.cs unity script
socket.on('GET_USERS_LIST',function(pack){

   if(currentUser)
   {
       //spawn all connected clients for currentUser client 
        clients.forEach( function(i) {
		    if(i.id!=currentUser.id)
			{ console.log("name: "+i.name);
		      //send to the client.js script
		      socket.emit('UPDATE_USER_LIST',i.id,i.name,i.publicAddress);
			  
		    }//END_IF
	   
	     });//end_forEach
   
   }
  

});//END_SOCKET.ON


		
	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('MESSAGE', function (_data)
	{
		
		
	  var data = JSON.parse(_data);	
	  
	  
	  if(currentUser)
	  {
	    // send current user position and  rotation in broadcast to all clients in game
       socket.emit('UPDATE_MESSAGE', currentUser.id,data.message);
	   // send current user position and  rotation in broadcast to all clients in game
       socket.broadcast.emit('UPDATE_MESSAGE', currentUser.id,data.message);
	
      
       }
	});//END_SOCKET_ON

	// X search: use hardcoded usernames and reply only to requester with results
	socket.on('X_SEARCH', function (_data)
	{
		try {
			var data = JSON.parse(_data);
			var nextToken = data.next_token || null;
			var query = buildXQueryFromUsernames();
			if (!query) {
				console.log('[X_SEARCH] No usernames available for search (SEARCH_USERNAMES length:', SEARCH_USERNAMES.length, ')');
				socket.emit('X_SEARCH_RESULTS', { tweets: [], next_token: null, error: 'no_usernames' });
				return;
			}
			console.log('[X_SEARCH] Searching with query:', query);
			fetchXRecent(query, nextToken).then(function(apiRes){
				var flattened = flattenXResponse(apiRes).slice(0, 20);
				var next = apiRes && apiRes.meta && apiRes.meta.next_token ? apiRes.meta.next_token : null;
				console.log('[X_SEARCH] Found ' + flattened.length + ' tweets');
				socket.emit('X_SEARCH_RESULTS', { tweets: flattened, next_token: next });
			}).catch(function(err){
				console.error('[X_SEARCH] error:', err && err.message ? err.message : err);
				socket.emit('X_SEARCH_RESULTS', { tweets: [], next_token: null, error: 'search_failed' });
			});
		} catch (e) {
			console.error('[X_SEARCH] bad payload');
			socket.emit('X_SEARCH_RESULTS', { tweets: [], next_token: null, error: 'bad_payload' });
		}
	});//END_SOCKET_ON

	// Scan user posts for analytics and payment
	socket.on('SCAN_USER_POSTS', function (_data)
	{
		try {
			var data = JSON.parse(_data);
			var username = data.username || '';
			var daysBack = parseFloat(data.daysBack) || 6.0;
			var walletAddress = data.walletAddress || '';

			if (!username) {
				socket.emit('SCAN_USER_POSTS_RESULT', { totalPosts: 0, clubMoonPosts: 0, newViews: 0, paymentSuccess: false, error: 'missing_username' });
				return;
			}

			scanUserPosts(username, daysBack, walletAddress).then(function(results){
				console.log('[SCAN_USER_POSTS] success for @' + username + ':', results);
				socket.emit('SCAN_USER_POSTS_RESULT', results);
			}).catch(function(err){
				console.error('[SCAN_USER_POSTS] error:', err && err.message ? err.message : err);
				socket.emit('SCAN_USER_POSTS_RESULT', { totalPosts: 0, clubMoonPosts: 0, newViews: 0, paymentSuccess: false, error: 'scan_failed' });
			});
		} catch (e) {
			console.error('[SCAN_USER_POSTS] bad payload');
			socket.emit('SCAN_USER_POSTS_RESULT', { totalPosts: 0, clubMoonPosts: 0, newViews: 0, paymentSuccess: false, error: 'bad_payload' });
		}
	});//END_SOCKET_ON

	// Begin OAuth 1.0a: provide request token and redirect URL
	socket.on('X_AUTH_START', function(){
		try{
			console.log('[X_AUTH_START] from', socket.id);
			if (!X_OAUTH1_CONSUMER_KEY || !X_OAUTH1_CONSUMER_SECRET || !APP_BASE_URL){
				console.error('[X_AUTH_START] server_not_configured');
				socket.emit('X_AUTH_URL', { ok:false, error:'server_not_configured' });
				return;
			}
			var method = 'POST';
			var url = 'https://api.x.com/oauth/request_token';
			var callback = APP_BASE_URL + '/x/oauth/callback';
			// Build signature including oauth_callback
			var headerParams = {
				oauth_consumer_key: X_OAUTH1_CONSUMER_KEY,
				oauth_nonce: crypto.randomBytes(16).toString('hex'),
				oauth_signature_method: 'HMAC-SHA1',
				oauth_timestamp: Math.floor(Date.now()/1000).toString(),
				oauth_version: '1.0'
			};
			var baseParams = Object.assign({ oauth_callback: callback }, headerParams);
			var baseString = buildSignatureBase(method, url, baseParams);
			var signingKey = percentEncode(X_OAUTH1_CONSUMER_SECRET)+'&';
			var signature = hmacSha1(signingKey, baseString);
			var oauthParams = Object.assign({ oauth_callback: callback, oauth_signature: signature }, headerParams);
			var authHeader = 'OAuth ' + Object.keys(oauthParams).map(function(k){ return percentEncode(k)+'="'+percentEncode(oauthParams[k])+'"';}).join(', ');
			var opt = { hostname:'api.x.com', path:'/oauth/request_token', method:'POST', headers:{ 'Authorization': authHeader } };
			var rq = https.request(opt, function(rs){
				var buf='';
				rs.on('data', function(c){ buf+=c; });
				rs.on('end', function(){
					try{
						var parts = {};
						buf.split('&').forEach(function(p){ var kv=p.split('='); parts[kv[0]]=kv[1]; });
						if (parts.oauth_callback_confirmed !== 'true') {
							console.error('[X_AUTH_START] callback_not_confirmed', buf);
							return socket.emit('X_AUTH_URL', { ok:false, error:'callback_not_confirmed' });
						}
						var oauth_token = parts.oauth_token;
						var oauth_token_secret = parts.oauth_token_secret;
						oauthTokenToSecret[oauth_token] = oauth_token_secret;
						oauthTokenToSocket[oauth_token] = socket.id;
						var redirectUrl = 'https://api.x.com/oauth/authenticate?oauth_token=' + oauth_token;
						console.log('[X_AUTH_START] auth url ready');
						socket.emit('X_AUTH_URL', { ok:true, url: redirectUrl });
					}catch(e){ console.error('[X_AUTH_START] parse_error', e); socket.emit('X_AUTH_URL', { ok:false, error:'parse_error' }); }
				});
			});
			rq.on('error', function(err){ console.error('[X_AUTH_START] request_error', err && err.message ? err.message : err); socket.emit('X_AUTH_URL', { ok:false, error:'request_error' }); });
			rq.end();
		}catch(e){ console.error('[X_AUTH_START] internal_error', e && e.message ? e.message : e); socket.emit('X_AUTH_URL', { ok:false, error:'internal_error' }); }
	});

	// Raid a selected post: broadcast to all clients
	socket.on('RAID_POST', function (_data)
	{
		try {
			var payload = (typeof _data === 'string') ? JSON.parse(_data) : _data;
			var tid = payload && payload.id ? String(payload.id) : '';
			if (!tid) { return; }
			if (raidedTweetIds[tid]) { return; }
			raidedTweetIds[tid] = true;
			io.emit('RAID_POST', payload);
		} catch (e) {
			console.error('[RAID_POST] bad payload');
		}
	});//END_SOCKET_ON

	// Generate GPT reply text server-side based on tweet content and character prompt
	socket.on('GENERATE_REPLY', function(_data){
		try {
			var data = (typeof _data === 'string') ? JSON.parse(_data) : _data;
			var tweetText = data && data.text ? String(data.text) : '';
			var tweetAuthor = data && data.author ? String(data.author) : '';
			var tweetId = data && data.tweetId ? String(data.tweetId) : '';
			console.log('[GENERATE_REPLY] from', socket.id, 'tweetId:', tweetId, 'author:', tweetAuthor, 'text.len:', tweetText.length);
			var systemPrompt = (CHARACTER_PROMPT || 'You are a helpful assistant for social replies.') + ' Keep answers safe for work.';
			var userPrompt = 'Tweet by ' + tweetAuthor + ':\n"' + tweetText + '"\n\nTask: Write a single-sentence reply for X, natural tone, no hashtags, avoid @ mentions unless essential. Target length ~100 characters.';
			callOpenAIChat(systemPrompt, userPrompt).then(function(reply){
            // sanitize - no hard length cutoff, rely on prompt guidance
            reply = (reply || '').replace(/\s+/g,' ').trim();
				if (!reply || reply.length === 0) {
					reply = buildFallbackReply(tweetAuthor, tweetText);
				}
				console.log('[GENERATE_REPLY] success for tweetId:', tweetId, 'reply.len:', reply ? reply.length : 0, 'reply:', reply);
				socket.emit('GENERATE_REPLY_RESULT', { ok:true, reply: reply, tweetId: tweetId });
			}).catch(function(err){
				console.error('[GENERATE_REPLY] error:', err && err.message ? err.message : err);
				var fb = buildFallbackReply(tweetAuthor, tweetText);
				socket.emit('GENERATE_REPLY_RESULT', { ok:true, reply: fb, tweetId: tweetId });
			});
		} catch(e) {
			console.error('[GENERATE_REPLY] bad payload');
			socket.emit('GENERATE_REPLY_RESULT', { ok:false, error:'bad_payload', tweetId: '' });
		}
	});

	//create a callback function to handle raid post ID from NetworkManager.cs unity script
	socket.on('RAID_POST_ID', function (_data)
	{
		
		
	  var data = JSON.parse(_data);	
	  
	  console.log('[RAID_POST_ID] user '+data.id+' set raid post ID: '+data.post_id);
	  
	  if(currentUser)
	  {
	    // broadcast the raid post ID to all clients including the sender
       io.emit('RAID_POST_ID', currentUser.id, data.post_id);
      
       }
	});//END_SOCKET_ON
	


	
	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('PRIVATE_MESSAGE', function (_data)
	{
		
		
	  var data = JSON.parse(_data);	
	  
	  
	  if(currentUser)
	  {
	
	    // send current user position and  rotation in broadcast to all clients in game
        socket.emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id,data.message);
	 
	    sockets[data.guest_id].emit('UPDATE_PRIVATE_MESSAGE',data.chat_box_id, currentUser.id,data.message);
	
      }
	});//END_SOCKET_ON
	
	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('SEND_OPEN_CHAT_BOX', function (_data)
	{
		
		
	  var data = JSON.parse(_data);	
	  
	  
	  if(currentUser)
	  {
	
	   // send current user position and  rotation in broadcast to all clients in game
       socket.emit('RECEIVE_OPEN_CHAT_BOX', currentUser.id,data.player_id);
	   
	     //spawn all connected clients for currentUser client 
         clients.forEach( function(i) {
		    if(i.id==data.player_id)
			{ 
		      console.log("send to : "+i.name);
		      //send to the client.js script
		      sockets[i.id].emit('RECEIVE_OPEN_CHAT_BOX',currentUser.id,i.id);
			  
		    }//END_IF
	   
	     });//end_forEach
	
      
       }
	});//END_SOCKET_ON
	
	

	
	socket.on('MUTE_ALL_USERS', function ()
	{
			

	  if(currentUser )
      {
		currentUser.muteAll = true;
		clients.forEach(function(u) {
			 
		currentUser.muteUsers.push( clientLookup[u.id] );
			
			 
		 });
		
		  
	  }
	  
	  
	
     
	});//END_SOCKET_ON
	
	
	socket.on('REMOVE_MUTE_ALL_USERS', function ()
	{
			

	  if(currentUser )
      {
		currentUser.muteAll = false;
		while(currentUser.muteUsers.length > 0) {
         currentUser.muteUsers.pop();
        }
		
		  
	  }
	  
	  
	
     
	});//END_SOCKET_ON
	
	socket.on('ADD_MUTE_USER', function (_data)
	{
			
	  var data = JSON.parse(_data);	
	  
	  if(currentUser )
      {
		//console.log("data.id: "+data.id);
		console.log("add mute user: "+clientLookup[data.id].name);
		currentUser.muteUsers.push( clientLookup[data.id] );
		  
	  }
	  
	  
	
     
	});//END_SOCKET_ON
	
	socket.on('REMOVE_MUTE_USER', function (_data)
	{
			
	  var data = JSON.parse(_data);	
	  
	  if(currentUser )
      {
		
		 for (var i = 0; i < currentUser.muteUsers.length; i++)
		 {
			if (currentUser.muteUsers[i].id == data.id) 
			{

				console.log("User "+currentUser.muteUsers[i].name+" has removed from the mute users list");
				currentUser.muteUsers.splice(i,1);

			};
		};
		  
	  }
	  
	  
	
     
	});//END_SOCKET_ON
	
	
	
	
	
 socket.on("VOICE", function (data) {
		
		var minDistanceToPlayer = 3;
		


  if(currentUser )
  {
	  
	  
   
   var newData = data.split(";");
   
    newData[0] = "data:audio/ogg;";
    newData = newData[0] + newData[1];

     
    clients.forEach(function(u) {
		
		var distance = getDistance(parseFloat(currentUser.posX), parseFloat(currentUser.posY),parseFloat(u.posX), parseFloat(u.posY))
		
		var muteUser = false;
		
		 for (var i = 0; i < currentUser.muteUsers.length; i++)
		 {
			if (currentUser.muteUsers[i].id == u.id) 
			{
				
				muteUser = true;


			};
		};
		
	//console.log("distance: "+distance);
	
	 // console.log("mute user: "+muteUser);
     
      if(sockets[u.id]&&u.id!= currentUser.id&&!currentUser.isMute&& distance < minDistanceToPlayer &&!muteUser &&! sockets[u.id].muteAll)
      {
		//  console.log("current user: "+currentUser.name);
		  
		// console.log("u.name: "+u.name);
     
    
        //sockets[u.id].emit('UPDATE_VOICE',currentUser.id,newData);
		 sockets[u.id].emit('UPDATE_VOICE',newData);
		 
		
         sockets[u.id].broadcast.emit('SEND_USER_VOICE_INFO', currentUser.id);
	
      }
	  
    });
    
    

  }
 
});



socket.on("AUDIO_MUTE", function (data) {

if(currentUser)
{
  currentUser.isMute = !currentUser.isMute;

}

});
	

    // called when the user desconnect
	socket.on('disconnect', function ()
	{
     
	    if(currentUser)
		{
		 currentUser.isDead = true;
		 
		 //send to the client.js script
		 //updates the currentUser disconnection for all players in game
		 socket.broadcast.emit('USER_DISCONNECTED', currentUser.id);
		
		
		 for (var i = 0; i < clients.length; i++)
		 {
			if (clients[i].name == currentUser.name && clients[i].id == currentUser.id) 
			{

				console.log("User "+clients[i].name+" has disconnected");
				clients.splice(i,1);

			};
		};
		
		}
		
    });//END_SOCKET_ON
		
});//END_IO.ON

function gameloop() {
	

	  //spawn all connected clients for currentUser client 
         clients.forEach( function(u) {
		    
		
		    //spawn all connected clients for currentUser client 
         vehicles.forEach( function(i) {
			 

		
		
		     sockets[u.socketID].emit('SPAWN_VEHICLE',i.id,i.name,i.model,i.posX,i.posY,i.posZ,i.currentState,i.myClientId);
		     
		     //send to the client.js script
			 sockets[u.socketID].emit('UPDATE_VEHICLE_STATE', i.myClientId,i.id,i.currentState);
			  
			  
	   
	     });//end_forEach
		});//end_forEach
		 
		 
		 
}

setInterval(gameloop, 1000);
// Adicionando a propriedade posY no array vehicleTypes
const vehicleTypes = [
  { name: 'motorcycle', model: 0},
  { name: 'car', model: 1}

];

function createVehicle(name, model, posX, posY, posZ) {
  return {
    id: uuidv4(),
    name: name,
    model: model,
    charModel: model.toString(),
    isLocalVehicle: false,
    posX: posX.toString(),
    posY: posY.toString(),
    posZ: posZ.toString(),
    spherePosX: '',
    spherePosY: '',
    spherePosZ: '',
    defaultPosition: `${posX},${posY},${posZ}`,
    rotation: '',
    acceleration: '',
    offSpin: '',
    wheels_rot: '',
    currentState: 'available',
    myClientId: '',
    bornPointID: 1
  };
}

function generateRandomPosition(vehicleType) {
  return {
    x: (Math.random() * 100 - 50).toFixed(2), // Random X position between -50 and 50
    y:0,
    z: (Math.random() * 100 - 50).toFixed(2) // Random Z position between -50 and 50
  };
}



// Criar múltiplos veículos com repetições
for (let i = 0; i < 10; i++) { // Ajustar o número de veículos conforme necessário
  const randomType = vehicleTypes[Math.floor(Math.random() * vehicleTypes.length)];
  const randomPos = generateRandomPosition(randomType);
  
  const vehicle = createVehicle(randomType.name, randomType.model, randomPos.x, randomPos.y, randomPos.z);
  vehicles.push(vehicle);
  vehicleLookup[vehicle.id] = vehicle;
}


console.log('Vehicles:', vehicles);

http.listen(process.env.PORT ||3000, function(){
	console.log('listening on *:3000');
});
console.log("------- server is running -------");