#!/usr/bin/env node

var url = require("url");
var net = require("net");
var _ = require("lodash");
var async = require("async");
var Tracker = require("peer-search/tracker");
var events = require('events');

//var cfg, db, indexer, importer;
var cfg, indexer, importer;

var nameParser = require("../lib/nameParser");
var log = require("../lib/log");

var argv = module.parent ? { } : require("minimist")(process.argv.slice(2));

var mp = new events.EventEmitter();
var sources = { }, recurring = { };
var noProcessing = false;

mp.init = function(settings) {

	if (cfg) {
		log.important('Multipass has already been initiated.');
		return;
	}

	// set defaults
	if (!settings) settings = {};
	if (typeof settings.replicate === 'undefined') settings.replicate = true;

	cfg = require("../lib/cfg");

	// sync cfg with settings
	for (var key in settings) {
		if (settings.hasOwnProperty(key)) {
			cfg[key] = settings[key];
		}
	}

	indexer = require("../lib/indexer");
	importer = require("../lib/importer");
	
	importer.on('linkError',function(impLink) {
		mp.emit('linkError', impLink);
	});

	if (cfg.sources) cfg.sources.forEach(mp.importQueue.push);

}

/* Collect infoHashes from source
 */

mp.import = function(link) {
	sources[link] = { progress: 0, total: 0 };
	this.importQueue.push(link);
}

mp.processing = function(shouldI) {
	if (shouldI) noProcessing = false;
	else noProcessing = true;
}

mp.importQueue = async.queue(function(source, next) {
	source = typeof(source) == "string" ? { url: source } : source;

	if (argv["disable-collect"]) { log.important("skipping "+source.url+" because of --disable-collect"); return next(); }

	if (source.fn) return source.fn(mp, function() {
		if (source.interval) recurring[source.url] = setTimeout(function() { mp.importQueue.push(source) }, source.interval); // repeat at interval - re-push
	});

//	log.important("importing from "+source.url);
	importer.collect(source, function(err, status) {
		if (err) log.error(err);
		else {
//			log.important("importing finished from "+source.url+", "+status.found+" infoHashes, "+status.imported+" of them new, through "+status.type+" importer ("+(status.end-status.start)+"ms)");
			buffering(source, status.found);
			mp.emit('parserFinished', source.url);
		}
		
		if (source.interval) recurring[source.url] = setTimeout(function() { mp.importQueue.push(source) }, source.interval); // repeat at interval - re-push

		next();
	}, function(torrent, extra) {
		mp.emit("starterInfo", source.url, torrent);
		log.hash(torrent, "collect");
		if (!argv["disable-process"] && !noProcessing) mp.processQueue.push({ torData: torrent, extra: extra, hints: extra && extra.hints, source: source });
		// extra - collected from the source, can be info like uploaders/downloaders, category, etc.
		// hints - hints to particular meta information already found from the source, like imdb_id, season/episode
	});
}, 1);

/* Process & index infoHashes
 */
mp.processQueue = async.queue(function(task, _next) {
	var next = _.once(function() { called = true;
	buffering(task.source);
	_next() }), called = false;
	setTimeout(function() {
		next();
		if (!called) log.error("process timeout for "+task.torData.infoHash)
	}, 10*1000);

	log.hash(task.torData.infoHash, "processing");

	// WARNING: no skip logic here, as we need at least to update .sources and seed/leech data		
	// Pass a merge of existing torrent objects as a base for indexing		
	var noChanges;

	async.auto({
		index: function(cb) { indexer.index(task, { }, function(err, tor, nochanges) {
			if (tor && tor.category) {
				mp.emit("found", task.source.url, tor);
				cb('die');
			} else {
				noChanges = nochanges;
				if (err && tor && tor.title) {
					mp.emit("minimalInfo", task.source.url, tor);
					cb(err);
				} else cb(err, tor);
			}
		})
	},
		seedleech: function(cb) {
			if (task.torData && task.torData.infoHash) {
				(task.torrent && task.torrent.popularityUpdated > (Date.now() - cfg.popularityTTL)) ? cb() : indexer.seedleech(task.torData.infoHash, cb)
			} else if (task.torData && (/^[a-f0-9]{40}$/i.test(task.torData) || /^[a-z2-7]{32}$/i.test(task.torData))) {
				(task.torrent && task.torrent.popularityUpdated > (Date.now() - cfg.popularityTTL)) ? cb() : indexer.seedleech(task.torData, cb)
			}
		}
	}, function(err, indexing) {
		if (err) {
			if (task.callback) task.callback(err); log.error(task.torData.infoHash, err);
			return next();
		}
		
		if (task.torData && (/^[a-f0-9]{40}$/i.test(task.torData) || /^[a-z2-7]{32}$/i.test(task.torData))) {
			keepHash = task.torData;
			task.torData = {};
			task.torData.infoHash = keepHash;
		}
		if (task.torrent == 0 && task.torData && task.torData.infoHash && (/^[a-f0-9]{40}$/i.test(task.torData.infoHash) || /^[a-z2-7]{32}$/i.test(task.torData.infoHash))) {
			task.torrent = {};
			task.torrent.hash = task.torData.infoHash;
		}

		// Note that this is a _.merge, popularity is not overriden
		var torrent = _.merge(indexing.index, indexing.seedleech ? { popularity: indexing.seedleech, popularityUpdated: Date.now() } : { });
		
		mp.emit("found", task.source.url, torrent);
		
		next();
		if (task.callback) task.callback(null, torrent);

		log.hash(task.torData.infoHash, "processed");
	});
}, (cfg && cfg.processingConcurrency) ? cfg.processingConcurrency : 6);

/* Emit buffering event
 */
function buffering(source, total) {

	if (!source) return;
	else if (!source.url) { tmp = source; source = {}; source.url = tmp; }

	if (!isNaN(total)) {
		sources[source.url].total = total;
		if (sources[source.url].total == sources[source.url].progress) {
			mp.emit("finished", source.url);
		}
		return;
	}
	sources[source.url].progress++;
	var perc;
	perc = sources[source.url].progress/sources[source.url].total;
	perc = (Math.floor(perc * 100) / 100).toFixed(2);

	if (isFinite(perc)) {
		mp.emit("buffering", source.url, perc);
		if (perc == 1) {
			mp.emit("finished", source.url);
			delete sources[source.url];
		}
	}
}

/* Programatic usage of this
 */
mp.nameParser = nameParser;
if (module.parent) return module.exports = mp;
else mp.init();

/* Stremio Addon interface
 */
//if (cfg.stremioAddon) require("../stremio-addon/addon")(cfg.stremioAddon);


