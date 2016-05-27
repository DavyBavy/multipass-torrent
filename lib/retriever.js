var request = require("needle"),
    async = require("async"),
    _ = require("lodash"),
    needle = require("needle"),
    util = require("util"),
    cfg = require("./cfg"),
    torrentStream = require("torrent-stream"),
    bencode = require("bencode"),
    parseTorrent = require("parse-torrent");
//    parseTorrent = require("parse-torrent"),
//	nameParser = require("./nameParser");

var downloadSources = cfg.downloadSources || [];

var defaultHeaders = {
    "accept-charset" : "ISO-8859-1,utf-8;q=0.7,*;q=0.3",
    "accept-language" : "en-US,en;q=0.8",
    "accept" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/45.0.2454.99 Safari/537.36" 
};

function parseK(url, task, cb) {

    var result, errors = [], sources = (task.url ? [{ formatted:task.url }] : []).concat(downloadSources);

	var source = sources.shift();

	needle.get(url, {
		open_timeout: 3500, read_timeout: 3500,
		agent: module.exports.getAgent(),
		follow_max: 3, compressed: true,
		headers: _.extend({ referer: source.url || source.formatted }, defaultHeaders)
	}, function(err, res, body) {
		if (err) { err.source = url; errors.push(err); return cb(err); }
		else if (res && res.statusCode != 200) { errors.push(_.extend(new Error("status code "+res.statusCode), { source: url })); return cb(new Error("status code "+res.statusCode)) }

		if (!body) return cb(new Error('no html body found'));
		 
		apiResp = JSON.parse(body);
		
		if (apiResp && apiResp.total_results == "1" && apiResp.list[0] && apiResp.list[0].hash && apiResp.list[0].hash == task.torData.infoHash) {
			result = apiResp.list[0];
			cb(null,result);
		} else cb(new Error("k api error"));
		
	});

}

var kQueue = async.queue(function(task,cb) {

//console.log('QUEUED');

	if (task.torData.title) {
		var url = window.atob('aHR0cHM6Ly9rYXQuY3IvanNvbi5waHA/cT0=')+escape('"'+task.torData.title+'"');
		parseK(url,task,function(err,tor) {
			task.callback(err,tor);
			cb();
		});
	} else {
		// fetch correct title
		try {
		needle.head(window.atob('aHR0cHM6Ly9rYXQuY3IvdXNlYXJjaC8=')+task.torData.infoHash+'/', { compressed: false }, function(err, resp) {
			if (err) {
//				console.log("k api error");
				task.callback(new Error("k api error"));
				cb();
			} else {
//				console.log("HEADERS");
//				console.log(resp);
				if (resp && resp.headers && resp.headers.location) {
					if (resp.headers.location == '/torrent-t0.html') {
						// not found
						task.callback(new Error("cannot find title from hash (404 Not Found)"));
//						console.log("cannot find title from hash (404 Not Found)");
						cb();
					} else {
						loc = resp.headers.location.substr(1);
						loc = loc.substr(0,loc.lastIndexOf('-'));
						loc = loc.split('-').join(' ');
//						console.log('found title!');
//						console.log(loc);
						url = window.atob('aHR0cHM6Ly9rYXQuY3IvanNvbi5waHA/cT0=')+escape('"'+loc+'"');
						parseK(url,task,function(err,tor) {
							task.callback(err,tor);
							cb();
						});
					}
				} else {
//					console.log('cannot find title');
					task.callback(new Error("cannot find title from hash"));
					cb();
				}
			}
		}, function(err) {
			console.log('woah');
			console.log(err);
		});
		} catch(err) {
			console.log('kek');
			console.log(err);
		}
	}

}, 2);

var downloader = async.queue(function(task, cb)
{
	
//	console.log('downloader');
//	console.log(task);
    setTimeout(cb, 500); /* This async queue is simply a rate limiter */

    var result, errors = [], sources = (task.url ? [{ formatted:task.url }] : []).concat(downloadSources);

    async.whilst(function() { return !result && sources.length }, function(innerCb)
    {
        var source = sources.shift(),
            innerCb = _.once(innerCb),
            url = source.formatted ? source.formatted : util.format(source.url, [ task.infoHash.toUpperCase() ]);

        needle.get(url, {
            open_timeout: 3500, read_timeout: 3500,
            agent: module.exports.getAgent(),
            follow_max: 3, compressed: true,
            headers: _.extend({ referer: source.url || source.formatted }, defaultHeaders)
        }, function(err, res, body) {
            if (err) { err.source = url; errors.push(err); return innerCb(); }
            else if (res && res.statusCode != 200) { errors.push(_.extend(new Error("status code "+res.statusCode), { source: url })); return innerCb() }

            if (!body) return innerCb();
             
            try { 
                if (typeof(body) == "string") body = JSON.parse(body);
                body = body["piece length"] ? bencode.encode({ info: _.extend({ pieces: [] }, body) }) : body;
                result = parseTorrent(body);
                result.infoHash = task.infoHash;
                if (! result.files) throw new Error("no files found in torrent");
            } catch(e) { e.source = url; errors.push(e) };
            innerCb();
        });
    }, function()
    {
        if (! (result && result.infoHash)) return task.callback(errors.concat([new Error("Did not manage to download parsable torrent")]),task.oldData);
        task.callback(null, result);
    });
}, 2);

// TODO: ability to rate-limit that section of the code
// OR just use a rate-limited peer-search instead of torrent-stream's peer searching
function fetchTorrent(infoHash, opts, cb) {
    var engine = new torrentStream(infoHash, { 
        connections: 30,
        trackers: cfg.fetchTorrentTrackers,
    });
    var cb = _.once(cb);

    engine.ready(function() { 
        cb(null, engine.torrent);
        engine.destroy(); 
    });
    setTimeout(function() {
        cb(new Error("fetchTorrent timed out"));
        engine.destroy();
    }, 15 * 1000);
};

function startK(torData, opts, cb) {
//	console.log('starting k:');
//	console.log(torData);
	if ((/^[a-f0-9]{40}$/i.test(torData) || /^[a-z2-7]{32}$/i.test(torData))) {
		mgn = torData;
		torData = {};
		torData.href = "magnet:?xt=urn:btih:"+mgn;
		torData.infoHash = mgn;
	}
	
	kQueue.push({ torData: torData, opts: opts, callback: function(err, kTorrent) {
		
		if (err) {
			
//			console.log("ERROR: FETCHING NORMALLY");
			
			if (typeof(opts) == "function") cb = opts;
			if (! (opts && typeof(opts) == "object")) opts = {};
			
//			downloadTorrent(torData, opts, cb);

//console.log('before downloader');
//console.log(torData);
//console.log(opts);

			downloader[opts.important ? "unshift" : "push"]({ infoHash: torData.infoHash, oldData: torData, callback: function(err, torrent) {
//				if (err && opts.important) {
				if (err) {
//					console.log('fetch from swarm');
					return fetchTorrent(torData.infoHash, opts, cb);
				}
//				console.log("ERR");
//				console.log(err);
//				console.log(torrent);
				if (err) return cb(err,torrent);
//				console.log("TORCACHE");
//				console.log(torrent);
				cb(null, torrent);
			}, url: opts.url });
			
		} else {
			
			if (err && opts.important) {
//				console.log('fetch from swarm 2');
				return fetchTorrent(torData.infoHash, opts, cb);
			}
			if (err) return cb(err);
			cb(null, kTorrent);
			
		}
		
	}, url: opts.url });
}

function downloadTorrent(torData, opts, cb)
{
    if (typeof(opts) == "function") cb = opts;
    if (! (opts && typeof(opts) == "object")) opts = {};

    downloader[opts.important ? "unshift" : "push"]({ infoHash: torData.infoHash, callback: function(err, torrent) {
        if (err && opts.important) return fetchTorrent(torData.infoHash, opts, cb);
        if (err) return cb(err);
        cb(null, torrent);
    }, url: opts.url })
}

module.exports = { k: startK, retrieve: startK };
module.exports.getAgent = function() { return undefined }; // dummy, to replace if you want your own agent
