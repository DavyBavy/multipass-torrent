var byline = require("byline"),
	URI = require("url"),
	noDups = {},
	waiters = {};

module.exports = function(stream, source)
{
	noDups[source] = [];
	
    stream = stream.pipe(byline.createStream()).on("data", function(line)
    {
        /* Cut the string into RegEx. this is my last resort. */
		var line = unescape(unescape(line.toString()));
		var magnets = line.match(/magnet:\?xt=urn:[a-z0-9]+:[a-z0-9]{40}[\:&+-_A-Za-z0-9]+/ig);
		if (magnets) {
			magnets.forEach(function(href) {
				if (href.includes(']]>')) href = href.substr(0,href.indexOf(']]>'));
//				console.log(href);
				pData = URI.parse(href,true).query;
				magnetParser = {};
				magnetParser.infoHash = href.match(new RegExp("([0-9A-Fa-f]){40}", "g"))[0];
				
//				console.log(magnetParser);
				
				if (noDups[source].indexOf(magnetParser.infoHash) == -1) {
					
					if (waiters[magnetParser.infoHash]) {
						clearTimeout(waiters[magnetParser.infoHash]);
						delete waiters[magnetParser.infoHash];
					}

					noDups[source].push(magnetParser.infoHash);
	
					magnetParser.href = href;
	
					if (pData.dn) magnetParser.title = pData.dn;
					if (pData.tr) magnetParser.trackers = pData.tr;
	
					stream.emit("infoHash", magnetParser, source.addon);
					
				}
			});
		} else {
		
			var hashes = line.match(new RegExp("([0-9A-Fa-f]){40}", "g"));
			
			if (hashes) {
				
				hashes.forEach(function(hash) {

					if (noDups[source].indexOf(hash) == -1) {

						waiters[hash] = setTimeout(function(savedSource,savedHash,savedStream) {
							return function() {
								if (noDups[savedSource]) noDups[savedSource].push(savedHash);
								savedStream.emit("infoHash", { infoHash: savedHash, href: 'magnet:?xt=urn:btih:' + savedHash }, savedSource.addon);
//								savedStream.emit("infoHash", { infoHash: savedHash }, savedSource.addon);
							}
						}(source,hash,stream), 500);

//						if (noDups[source]) noDups[source].push(hash);
	
//						stream.emit("infoHash", { infoHash: hash }, source.addon);
						
					}
					
				});
			}
			
		}
    });
	
	stream.on('finish', function () {
//		console.log('waiters');
//		console.log(waiters);
		delete noDups[source];
	});
	
	return stream;
};