oc.layer = function opencoin_layer(api,storage) {
    this.api = api;
    this.storage = storage;
    this.mq = storage.message_queue;
    this.sh = {} //server handler functions;

    this.isEmpty = function(a) {
        if (a == undefined) return true;
        if (a.length == undefined) return false;
        if (a.length == 0) return true;
        return false;
    }


    this.buildMessage = function(name) {
        var message = new oc.c[name]();
        var id = this.mq.next_id;
        message.message_reference = id;
        return message;
    }


    this.buildReply =function(message,name,status_code,status_description) {
        var reply = new oc.c[name]();
        reply.status_code = status_code || 200;
        reply.status_description = status_description || 'ok';
        reply.message_reference = message.message_reference;
        return reply;
    }


    this.queueMessage = function(message) {
        var id = message.message_reference;
        this.mq[id] = message;
        this.mq.next_id = id+1;
    }


    this.dispatch = function(data) {
        var type = data.type;
        if (!(type in oc.registry)) throw 'non existent type';
        obj = new oc.registry[type]();
        obj.fromData(data);
        handler = this.sh[obj.type];
        if (handler == undefined) throw 'non existent handler for "'+obj.type+'"';
        out = handler.call(this,obj);
        return out;
    }

    this.serializeStorage = function() {
        function innerToData(value,ignored,master) {
            var type = typeof(value);
            if (['string','number'].indexOf(type)!=-1) {
                return value;    
            } else if (Array.isArray(value)) {
                var tmp = [];
                for (var i in value) {
                    tmp[i] = innerToData(value[i],ignored,master);    
                }
                return tmp;
            } else if (value.toData != undefined) {//must be an container
                return value.toData(ignored,master);
            } else {
                var tmp = {};
                for (var name in value) {
                    tmp[name] = innerToData(value[name],ignored,master);    
                }
                return tmp;
            }
        }

        var out = {};
        for (name in this.storage) {
            out[name] = innerToData(this.storage[name],undefined,this.storage);
        }

        return out;
 
    }

    this.toJson = function() {
        return JSON.stringify(this.serializeStorage(),null,4);    
    }

    //////////////////// CDDC /////////////////////////////////////

    this.addCDDC = function(cddc) {
        var serial = cddc.cdd.cdd_serial;
        this.storage.cddcs[serial] = cddc;
    }


    this.getCurrentCDDC = function () {
        var keys = Object.keys(this.storage.cddcs);
        keys.sort();
        var highest = keys[keys.length-1];
        return this.storage.cddcs[highest];
    }


    this.requestCDDSerial = function() {
        var message = this.buildMessage('RequestCDDSerial');
        this.queueMessage(message);
        return message;
    }


    this.responseCDDSerial = function (message) {
        var current = this.getCurrentCDDC();
        reply = this.buildReply(message,'ResponseCDDSerial');
        reply.cdd_serial = current.cdd.cdd_serial;
        return reply;
    }
    this.sh['request cdd serial'] = this.responseCDDSerial;


    this.handleResponseCDDSerial = function (response) {
        delete this.mq[response.message_reference];
        return response.serial;
    } 
    this.sh['response cdd serial'] = this.handleResponseCDDSerial;


    this.requestCDD = function (serial) {
        var message = this.buildMessage('RequestCDD');
        message.cdd_serial = serial;
        return message;
    }


    this.responseCDD = function(message) {
        var cddc = this.storage.cddcs[message.cdd_serial];
        if (cddc == undefined) {
            reply = this.buildReply(message,'ResponseCDD',404,'not found');
        } else {
            reply = this.buildReply(message,'ResponseCDD');
            reply.cdd = cddc;
        }
        return reply;
    }
    this.sh['request cdd'] = this.responseCDD;


    this.handleResponseCDD = function (response) {
        var cddc = response.cdd;
        var cdd = cddc.cdd;
        var verified = this.api.suite.verifyContainerSignature(cdd.issuer_public_master_key,cdd,cddc.signature);
        if (!verified) throw 'could not verify cdd signature';
        this.addCDDC(cddc);
        delete this.mq[response.message_reference];
    } 
    this.sh['response cdd'] = this.handleResponseCDD;


    ///////////////// Mint keys ////////////////////////////////
    
    this.addMKC = function(mkc,private_key) {
        var mk = mkc.mint_key;
        this.storage.mintkeys[mk.id]=mkc;
        var denomination = mk.denomination;
        if (this.storage.mintkeys.denominations[denomination] == undefined) 
            this.storage.mintkeys.denominations[denomination] = [];
        var denominations = this.storage.mintkeys.denominations[denomination];
        if (denominations.indexOf(mk.id) == -1) {
            denominations[denominations.length]=mk.id;
            console.log('added key '+ mk.id);
            if (private_key!=undefined) {
                this.storage.private_keys[mk.id]=private_key;
            }
        } else console.log('we already had that key');

    }

    this.getCurrentMKC = function (denomination) {
        var d = this.storage.mintkeys.denominations[denomination];
        var id =  d[d.length-1]; 
        return this.storage.mintkeys[id];
    }


    this.requestMintKeys = function(mint_key_ids,denominations) {
        var message = this.buildMessage('RequestMintKeys');
        message.mint_key_ids = mint_key_ids;
        message.denominations = denominations;
        this.queueMessage(message);
        return message;
    }

    this.responseMintKeys = function(message) {
        var reply = this.buildReply(message,'ResponseMintKeys');
        if (this.isEmpty(message.mint_key_ids) && this.isEmpty(message.denominations)) {
            var cddc = this.getCurrentCDDC();
            message.denominations = cddc.cdd.denominations;
        } 
       
        var keys = [];
        if (!this.isEmpty(message.mint_key_ids)) {
            for (var i in message.mint_key_ids) {
                var mkc = this.storage.mintkeys[message.mint_key_ids[i]];
                if (mkc != undefined) keys[keys.length] = mkc;
            }    
        } else { //denominations it is
            for (var i in message.denominations) {
                var d = message.denominations[i];
                var dk = this.storage.mintkeys.denominations[d]; //denominationkeys
                if (dk != undefined && dk.length) keys[keys.length] = this.storage.mintkeys[dk[dk.length-1]]; //the last one
            }
        }
        if (keys.length) {
            reply.keys = keys;    
        } else {
            reply.status_code = 404;
            reply.status_description = 'at least one key was not found';
        }
        return reply;
    }
    this.sh['request mint keys'] = this.responseMintKeys;


    this.handleResponseMintKeys = function (response) {
        var orig = this.mq[response.message_reference];
        var cddc = this.getCurrentCDDC();
        //if (orig == undefined) throw 'response to unknown request';
        if (response.keys.length == 0) throw 'no mint keys returned';
        for (var i in response.keys) {
            var mkc = response.keys[i];
            var verified = this.api.suite.verifyContainerSignature(cddc.cdd.issuer_public_master_key,mkc.mint_key,mkc.signature);
            if (!verified) throw 'could not verify mkc signature';
        }
        for (var i in response.keys) {
            this.addMKC(response.keys[i]); 
        }
        delete this.mq[response.message_reference];
    } 
    this.sh['response mint keys'] = this.handleResponseMintKeys;


    this.requestValidation = function(authinfo,amount) {
        var message = this.buildMessage('RequestValidation');
        var cddc = this.getCurrentCDDC();
        var tokens = this.api.tokenize(cddc.cdd.denominations,amount);
        var store = {};
        var blinds = [];
        //var refbase = this.api.getRandomInt(100000,999999);
        for (var i in tokens) {
            var t = tokens[i];
            var mkc = this.getCurrentMKC(t);
            var ref = 'r_'+i;
            var parts = this.api.makeBlind(cddc,mkc,ref);
            parts.r = this.api.suite.b2s(parts.r);
            store[ref] = parts;
            blinds[blinds.length] = parts.blind;
        }

        var tref = this.api.suite.b2s(this.api.suite.getRandomNumber(128));
        message.transaction_reference = tref;
        message.authorization_info = authinfo;
        message.blinds = blinds;
        this.storage.validation[tref]=store;
        this.queueMessage(message);
        return message;
    }

    this.responseValidation = function (message) {
        reply = this.buildReply(message,'ResponseValidation');
        
        var blinds = message.blinds;
        var sum = this.sanitycheckBlinds(blinds);
                
        //the magic of authorization
        if (!this.authorize(message.authorization_info,sum)) throw 'unauthorized';
        
        //this could be delayed
        reply.blind_signatures = this.batchSignBlinds(blinds);
        return reply;
    }
    this.sh['request validation'] = this.responseValidation;


    this.sanitycheckBlinds = function (blinds) {
        var sum = 0;
        var today = new Date();
        for (var i in blinds) {
            var blind = blinds[i];
            var keyid = blind.mint_key_id;
            if (keyid in {'bydate':0,'denominations':0}) throw 'evil key id';
            if (!keyid in this.storage.mintkeys) throw 'invalid key id';
            var key = this.storage.mintkeys[keyid].mint_key;
            if (today < key.sign_coins_not_before) throw 'future key';
            if (today > key.sign_coins_not_after) throw 'outdated key';
            sum += key.denomination;
        }
        return sum
    }


    this.batchSignBlinds = function(blinds) {
        var blind_signatures = [];
        for (var i in blinds) {
            var blind = blinds[i];
            var pk = this.storage.private_keys[blind.mint_key_id];
            var signature = this.api.signBlind(pk,blind);
            blind_signatures[blind_signatures.length] = signature;
        }
        return blind_signatures;
    }


    this.authorize = function (authinfo,amount) {
        //console.log('Authorize '+amount+ ' with '+authinfo);
        return true;
    }


    this.handleResponseValidation = function (response) {
        var bs = response.blind_signatures;
        var bsbyref = {};
        for (var i in bs) {
            var s = bs[i];
            bsbyref[s.reference] = s;
        }
        var message = this.mq[response.message_reference];
        var store = this.storage.validation[message.transaction_reference];
        var sum = 0;
        for (ref in store) {
            var parts = store[ref];
            var mkc = this.storage.mintkeys[parts.blank.mint_key_id];
            var s = bsbyref[ref];
            r =  this.api.suite.s2b(parts.r);
            var coin = this.api.makeCoin(parts.blank,s,r,mkc);
            this.addCoin(coin);
            sum += coin.token.denomination;
        }
        delete this.storage.validation[message.transaction_reference];
        delete this.mq[response.message_reference];
        return sum;
    } 
    this.sh['response validation'] = this.handleResponseValidation;


    this.addCoin = function(coin) {
        var coins = this.setDefault(this.storage.coins,coin.token.denomination,[]);
        coins[coins.length] = coin;
    }


    this.setDefault = function (obj,key,def) {
        var out = obj[key];
        if (out == undefined) {
            obj[key] = def;    
            out = obj[key];
        }
        return out;
    }



}
