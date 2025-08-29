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

var clients			= [];// to storage clients
var clientLookup = {};// clients search engine
var sockets = {};//// to storage sockets

var vehicles = [];
var vehicleLookup = {};



// Track tweets that have already been raided to avoid duplicates
var raidedTweetIds = {};

// X (Twitter) API minimal helpers
const X_API_HOST = 'api.twitter.com';
const X_RECENT_PATH = '/2/tweets/search/recent';
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN;

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
	return tweets.map(function(t) {
		var author = userById[t.author_id] || {};
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
		var authorUsername = author.username || '';
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
			return null;
		}
		return {
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
		};
	}).filter(function(x){ return x != null; });
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

	// X search: receive keywords and reply only to requester with results
	socket.on('X_SEARCH', function (_data)
	{
		try {
			var data = JSON.parse(_data);
			var keywords = data.keywords || '';
			var nextToken = data.next_token || null;
			var query = buildXQueryFromKeywords(keywords);
			if (!query) {
				socket.emit('X_SEARCH_RESULTS', { tweets: [], next_token: null });
				return;
			}
			fetchXRecent(query, nextToken).then(function(apiRes){
				var flattened = flattenXResponse(apiRes).slice(0, 20);
				var next = apiRes && apiRes.meta && apiRes.meta.next_token ? apiRes.meta.next_token : null;
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