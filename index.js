// _Extended_ (e)Domoticz Platform Plugin for HomeBridge by Marci [http://twitter.com/marcisshadow]
// V0.0.5 - 2016/02/01
//		- Properly implement UUID generation for custom chars & services
// V0.0.4 - 2016/01/31
//		- Fixed 'Siri Name' disappearance
// V0.0.3 - 2016/01/31
//		- Added General Usage Sensors (Type: General, SubType: Percentage)
// V0.0.2 - 2016/01/31
//		- Added Electric Consumption sensors (Type: General, SubType: kWh)
// V0.0.1 - 2016/01/31
//      - Initial version
//      - I make no claims to the quality of this shim. Function over form!
//
// ** Remember to add platform to config.json **
//
// Example config.json content:
//
// {
// 	"bridge": {
//         "name": "Homebridge",
//         "username": "CC:21:3E:E4:DE:33", // << Randomize this...
//         "port": 51826,
//         "pin": "031-45-154",
//     	},
//
// 	"platforms": [{
//         "platform": "eDomoticz",
//         "name": "eDomoticz",
//         "server": "127.0.0.1",	// or "user:pass@ip"
//         "port": "8080",
//		   "roomid": 0  	// 0 = all sensors, otherwise, room idx as shown at http://server:port/#/Roomplan
//	}],
//
// 	"accessories":[]
// }
//
//
// SUPPORTED TYPES:
// - Lightbulb              (haveDimmer, onValue, offValue options)
// - Switch                 (onValue, offValue options)
// - TemperatureSensor      ()
// - Battery                (batteryThreshold option)
// - Power Meter			()
// - Usage Sensors 		 	() [eg: CPU Load, Disk Load, Mem Load from Motherboard Sensors Hardware Device]


var Service, Characteristic, types, hapLegacyTypes;
var request = require("request");
var inherits = require('util').inherits;

module.exports = function(homebridge) {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  types = homebridge.hapLegacyTypes;
  uuid = homebridge.hap.uuid;

  fixInheritance(eDomoticzPlatform.TotalConsumption, Characteristic);
  fixInheritance(eDomoticzPlatform.CurrentConsumption, Characteristic);
  fixInheritance(eDomoticzPlatform.MeterDeviceService, Service);
  fixInheritance(eDomoticzPlatform.CurrentUsage, Characteristic);
  fixInheritance(eDomoticzPlatform.UsageDeviceService, Service);

  homebridge.registerAccessory("homebridge-eDomoticz", "eDomoticz", eDomoticzAccessory)
  homebridge.registerPlatform("homebridge-eDomoticz", "eDomoticz", eDomoticzPlatform);
}

function eDomoticzPlatform(log, config) {
	this.log = log;
	this.config = config;
	this.server = config["server"];
	this.port = config["port"];
	this.room = config["roomid"];
}

/* Handy Utility Functions */
function sortByKey(array, key) {
	return array.sort(function(a, b) {
		var x = a[key];
		var y = b[key];
		return ((x < y) ? -1 : ((x > y) ? 1 : 0));
	});
}

function roundToHalf(value) {
	var converted = parseFloat(value);
	var decimal = (converted - parseInt(converted, 10));
	decimal = Math.round(decimal * 10);
	if (decimal == 5) {
		return (parseInt(converted, 10) + 0.5);
	}
	if ((decimal < 3) || (decimal > 7)) {
		return Math.round(converted);
	} else {
		return (parseInt(converted, 10) + 0.5);
	}
}

function fixInheritance(subclass, superclass) {
    var proto = subclass.prototype;
    inherits(subclass, superclass);
    subclass.prototype.parent = superclass.prototype;
    for (var mn in proto) {
        subclass.prototype[mn] = proto[mn];
    }
}
/* End of Utility Functions */


/* Define Custom Services & Characteristics */

// PowerMeter Characteristics
eDomoticzPlatform.TotalConsumption = function() {
  var charUUID = uuid.generate('eDomoticz:customchar:TotalConsumption');
	Characteristic.call(this, 'Total Consumption', charUUID);
	this.setProps({
		format: 'string',
		perms: [Characteristic.Perms.READ]
	});
	this.value = this.getDefaultValue();
};

eDomoticzPlatform.CurrentConsumption = function() {
  var charUUID = uuid.generate('eDomoticz:customchar:CurrentConsumption');
	Characteristic.call(this, 'Current Consumption', charUUID);
	this.setProps({
		format: 'string',
		perms: [Characteristic.Perms.READ]
	})
	this.value = this.getDefaultValue();
};
// The PowerMeter itself
eDomoticzPlatform.MeterDeviceService = function(displayName, subtype) {
  var serviceUUID = uuid.generate('eDomoticz:powermeter:customservice');
	Service.call(this, displayName, serviceUUID, subtype);
	this.addCharacteristic(new eDomoticzPlatform.CurrentConsumption);
	this.addOptionalCharacteristic(new eDomoticzPlatform.TotalConsumption);
};

// Usage Meter Characteristics
eDomoticzPlatform.CurrentUsage = function() {
  var charUUID = uuid.generate('eDomoticz:customchar:CurrentUsage');
	Characteristic.call(this, 'Current Usage', charUUID);
	this.setProps({
		format: 'string',
		perms: [Characteristic.Perms.READ]
	})
	this.value = this.getDefaultValue();
};
// The Usage Meter itself
eDomoticzPlatform.UsageDeviceService = function(displayName, subtype) {
  var serviceUUID = uuid.generate('eDomoticz:usagedevice:customservice');
	Service.call(this, displayName, serviceUUID, subtype);
	this.addCharacteristic(new eDomoticzPlatform.CurrentUsage);
};
/* End of Custom Services & Characteristics */

eDomoticzPlatform.prototype = {
	accessories: function(callback) {
		var that = this;
		var foundAccessories = [];
		var asyncCalls = 0;

		function callbackLater() {
			if (--asyncCalls == 0) callback(foundAccessories);
		}

		this.log("Fetching Domoticz lights and switches...");

		asyncCalls++;
		var domurl;
		if (!(this.roomid) || this.roomid == 0) {
			domurl = "http://" + this.server + ":" + this.port + "/json.htm?type=devices&used=true&order=Name";
		} else {
			domurl = "http://" + this.server + ":" + this.port + "/json.htm?type=devices&plan=" + this.room + "&used=true&order=Name";
		}
		request.get({
			url: domurl,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						accessory = new eDomoticzAccessory(that.log, that.server, that.port, false, s.Used, s.idx, s.Name, s.HaveDimmer, s.MaxDimLevel, s.SubType, s.Type, s.BatteryLevel);
						foundAccessories.push(accessory);
					})
				}
				callbackLater();
			} else {
				that.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	}
}

function eDomoticzAccessory(log, server, port, IsScene, status, idx, name, haveDimmer, maxDimLevel, subType, Type, batteryRef) {
	this.log = log;
	this.server = server;
	this.port = port;
	this.IsScene = IsScene;		// Domoticz Scenes ignored for now...
	this.status = status;
	this.idx = idx;
	this.name = name;
	this.haveDimmer = haveDimmer;	// Dimming not supported at the moment - needs adding. Ditto RGB etc.
	this.maxDimLevel = maxDimLevel; // Dimming not supported at the moment - needs adding. Ditto RGB etc.
	this.subType = subType;
	this.Type = Type;
	this.batteryRef = batteryRef;
	this.onValue = "On";
	this.offValue = "Off";
	this.param = "switchlight"; 	//need an if(this.Type=='Lighting 1' || 'Lighting 2'){} etc to set param for all other types.
	this.access_url = "http://" + this.server + ":" + this.port + "/json.htm?";
	this.control_url = this.access_url + "type=command&param=" + this.param + "&idx=" + this.idx;
	this.status_url = this.access_url + "type=devices&rid=" + this.idx;
}

eDomoticzAccessory.prototype = {
	identify: function(callback) {
		callback();
	},
	setPowerState: function(powerOn, callback) {
		var url, that = this;
		if (powerOn) {
			url = that.control_url + "&switchcmd="+that.onValue;
			that.log("Setting power state to "+that.onValue);
		} else {
			url = that.control_url + "&switchcmd="+that.offValue;
			that.log("Setting power state to "+that.offValue);
		}
		request.put({
			url: url
		}, function(err, response) {
			if (err) {
				that.log("There was a problem sending command to " + that.name);
				that.log(response);
			} else {
				that.log(that.name + " - sent command succesfully");
			}
			callback();
		}.bind(this));
	},
	getPowerState: function(callback) {
		request.get({
			url: this.status_url,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				var value
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						value = (s.Data == "On") ? 1 : 0;
					})
				}
				callback(null, value);
			} else {
				this.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	},
	setValue: function(level, callback) {
		var url = this.control_url;
		this.log("Dummy Value-Set Operation in progress");
		callback();
	},
	getValue: function(callback) {
		request.get({
			url: this.status_url,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				var value
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						value = roundToHalf(s.Data.replace(/[^\d.-]/g, ''));
					})
				}
				callback(null, value);
			} else {
				this.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	},
	getStringValue: function(callback) {
		request.get({
			url: this.status_url,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				var value
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						value = s.Data;
					})
				}
				callback(null, value);
			} else {
				this.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	},
	getCPower: function(callback) {
		request.get({
			url: this.status_url,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				var value
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						value = s.Usage;
					})
				}
				callback(null, value);
			} else {
				this.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	},
	getTemperature: function(callback) {
		request.get({
			url: this.status_url,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				var value
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						value = roundToHalf(s.Temp);
					})
				}
				callback(null, value);
			} else {
				this.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	},
	getLowBatteryStatus: function(callback) {
		request.get({
			url: this.status_url,
			json: true
		}, function(err, response, json) {
			if (!err && response.statusCode == 200) {
				var value
				if (json['result'] != undefined) {
					var sArray = sortByKey(json['result'], "Name");
					sArray.map(function(s) {
						value = s.BatteryLevel;
					})
				}
				if (value > 20) {
					callback(null, 0);
				} else {
					callback(null, 1);
				}
			} else {
				this.log("There was a problem connecting to Domoticz.");
			}
		}.bind(this));
	},
	getServices: function() {
		var services = []
		var informationService = new Service.AccessoryInformation();
		informationService.setCharacteristic(Characteristic.Manufacturer, "eDomoticz").setCharacteristic(Characteristic.Model, this.Type).setCharacteristic(Characteristic.SerialNumber, "DomDev" + this.idx);
		services.push(informationService);
		switch (true) {
		case this.Type == "Lighting 1" || this.Type == "Lighting 2" || this.Type == "Scene":
			{
				if (this.Image == "Light") {
					var lightbulbService = new Service.Lightbulb(this.name);
					lightbulbService.getCharacteristic(Characteristic.On).on('set', this.setPowerState.bind(this)).on('get', this.getPowerState.bind(this));
					/* if( this.haveDimmer == true ) {
		                lightbulbService
		                    .addCharacteristic(new Characteristic.Brightness())
		                    .on('set', this.setValue.bind(this))
		                    .on('get', this.getValue.bind(this));
		            } */
					services.push(lightbulbService);
				} else {
					var switchService = new Service.Switch(this.name);
					switchService.getCharacteristic(Characteristic.On).on('set', this.setPowerState.bind(this)).on('get', this.getPowerState.bind(this));
					services.push(switchService);
				}
				break;
			}
		case this.Type == "General":
			{
				if (this.subType == "kWh") {
					var MeterDeviceService = new eDomoticzPlatform.MeterDeviceService("Power Usage");
					MeterDeviceService.getCharacteristic(eDomoticzPlatform.CurrentConsumption).on('get', this.getCPower.bind(this));
					MeterDeviceService.getCharacteristic(eDomoticzPlatform.TotalConsumption).on('get', this.getStringValue.bind(this));
					services.push(MeterDeviceService);
					break;
				} else if (this.subType == "Percentage") {
					var UsageDeviceService = new eDomoticzPlatform.UsageDeviceService("Current Usage");
					UsageDeviceService.getCharacteristic(eDomoticzPlatform.CurrentUsage).on('get', this.getStringValue.bind(this));
					services.push(UsageDeviceService);
					break;
				}
			}
		case this.Type == "Switch":
			{
				var switchService = new Service.Switch(this.name);
				switchService.getCharacteristic(Characteristic.On).on('set', this.setPowerState.bind(this)).on('get', this.getPowerState.bind(this));
				services.push(switchService);
				break;
			}
		case this.Type == "Temp" || this.Type == "Temp + Humidity + Baro":
			{
				var temperatureSensorService = new Service.TemperatureSensor(this.name);
				temperatureSensorService.getCharacteristic(Characteristic.CurrentTemperature).on('get', this.getTemperature.bind(this));
				temperatureSensorService.getCharacteristic(Characteristic.CurrentTemperature).setProps({
					minValue: -10
				});
				if (this.batteryRef && this.batteryRef < 101) { // if batteryRef == 255 we're running on mains
					temperatureSensorService.addCharacteristic(new Characteristic.StatusLowBattery()).on('get', this.getLowBatteryStatus.bind(this));
				}
				services.push(temperatureSensorService);
				break;
			}
		default:
			{
				var switchService = new Service.Switch(this.name);
					switchService.getCharacteristic(Characteristic.On).on('set', this.setPowerState.bind(this)).on('get', this.getPowerState.bind(this));
					services.push(switchService);
				break;
			}
		}
		return services;
	}
};
