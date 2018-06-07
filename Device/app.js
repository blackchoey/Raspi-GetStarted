// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const Client = require('azure-iot-device-mqtt').clientFromConnectionString;
const Message = require('azure-iot-device').Message;
const i2c = require('i2c-bus');

const connectionString = require('./config.json').connectionString;
const client = Client(connectionString);

// Datasheets: https://dlnmh9ip6v2uc.cloudfront.net/datasheets/Sensors/Magneto/HMC5883L-FDS.pdf
const HMC5883L = {
  I2C_ADDRESS: 0x1e,
  REGISTER_A: 0x00,
  REGISTER_B: 0x01,
  MODE_REGISTER: 0x02,
  DATA_OUTPUT_X_MSB: 0x03,
  DATA_OUTPUT_X_LSB: 0x04,
  DATA_OUTPUT_Z_MSB: 0x05,
  DATA_OUTPUT_Z_LSB: 0x06,
  DATA_OUTPUT_Y_MSB: 0x07,
  DATA_OUTPUT_Y_LSB: 0x08,
  STATUS_REGISTER: 0x09,
  IDENTIFICATION_REGISTER_A: 0x0a,
  IDENTIFICATION_REGISTER_B: 0x0b,
  IDENTIFICATION_REGISTER_C: 0x0c,
  DATA_OUTPUT_RATE_75: 0x00,
  DATA_OUTPUT_RATE_150: 0x04,
  DATA_OUTPUT_RATE_300: 0x08,
  DATA_OUTPUT_RATE_750: 0x0c,
  DATA_OUTPUT_RATE_1500: 0x10,
  DATA_OUTPUT_RATE_3000: 0x14,
  DATA_OUTPUT_RATE_7500: 0x18,
  NORMAL_MEASUREMENT: 0x00,
  POSITIVE_MEASUREMENT: 0x20,
  NEGATIVE_MEASUREMENT: 0x40,
  GAIN_88: 0x00,
  RESOLUTION_88: 0.73,
  GAIN_130: 0x20,
  RESOLUTION_130: 0.92,
  GAIN_190: 0x40,
  RESOLUTION_190: 1.22,
  GAIN_250: 0x60,
  RESOLUTION_250: 1.52,
  GAIN_400: 0x80,
  RESOLUTION_400: 2.27,
  GAIN_470: 0xa0,
  RESOLUTION_470: 2.56,
  GAIN_560: 0xc0,
  RESOLUTION_560: 3.03,
  GAIN_810: 0xe0,
  RESOLUTION_810: 4.35,
  CONTINUOUS_MEASUREMENT_MODE: 0x00,
  SINGLE_MEASURE_MODE: 0x01,
  IDLE_MODE: 0x02,
};

// Open /dev/i2c-1 adapter
const i2cBus = i2c.openSync(1);

// Configure HMC5883L field range to +/-1.3Ga, normal measurement, data output rate to 15Hz, continuous measure mode
i2cBus.writeByteSync(HMC5883L.I2C_ADDRESS, HMC5883L.REGISTER_A, HMC5883L.GAIN_130);
i2cBus.writeByteSync(HMC5883L.I2C_ADDRESS, HMC5883L.REGISTER_B, HMC5883L.NORMAL_MEASUREMENT | HMC5883L.DATA_OUTPUT_RATE_150);
i2cBus.writeByteSync(HMC5883L.I2C_ADDRESS, HMC5883L.MODE_REGISTER, HMC5883L.CONTINUOUS_MEASUREMENT_MODE);

// The total size of output data is 6 bytes:
// DATA_OUTPUT_X_MSB, DATA_OUTPUT_X_LSB, DATA_OUTPUT_Z_MSB, DATA_OUTPUT_Z_LSB, DATA_OUTPUT_Y_MSB, DATA_OUTPUT_Y_LSB
const outputData = Buffer.alloc(6);

// Offset of 3 axises output data
var offsetX = 0;
var offsetY = 0;
var offsetZ = 0;

// The output data is saved in global variable outputData
function getOutputData() {
  i2cBus.readI2cBlockSync(HMC5883L.I2C_ADDRESS, HMC5883L.DATA_OUTPUT_X_MSB, 6, outputData);
  const xDataAddrOffset = HMC5883L.DATA_OUTPUT_X_MSB - HMC5883L.DATA_OUTPUT_X_MSB;
  const yDataAddrOffset = HMC5883L.DATA_OUTPUT_Y_MSB - HMC5883L.DATA_OUTPUT_X_MSB;
  const xDataAddrOffset = HMC5883L.DATA_OUTPUT_Z_MSB - HMC5883L.DATA_OUTPUT_X_MSB;

  const x = outputData.readInt16BE(xDataAddrOffset) * HMC5883L.RESOLUTION_130 - offsetX;
  const y = outputData.readInt16BE(yDataAddrOffset) * HMC5883L.RESOLUTION_130 - offsetY;
  const z = outputData.readInt16BE(zDataAddrOffset) * HMC5883L.RESOLUTION_130 - offsetZ;

  return {x, y, z};
}

//// The offset data is saved in global variable offsetX, offsetY and offsetZ
function getOffset(callback) {
  console.log('Reset compass offset by moving the sensor in a figure 8 pattern...');
  let maxX, minX, maxY, minY, maxZ, minZ;

  const offsetFix = setInterval(function() {
    const res = getOutputData();
    const x = res.x;
    const y = res.y;
    const z = res.z;

    if (maxX === undefined || maxX < x) {
      maxX = x;
    } else if (minX === undefined || minX > x) {
      minX = x;
    }
  
    if (maxY === undefined || maxY < y) {
      maxY = y;
    } else if (minY === undefined || minY > y) {
      minY = y;
    }

    if (maxZ === undefined || maxZ < z) {
      maxZ = z;
    } else if (minZ === undefined || minZ > z) {
      minY = z;
    }
  }, 100);

  setTimeout(() => {
    clearInterval(offsetFix);
    offsetX = (maxX + minX) / 2;
    offsetY = (maxY + minY) / 2;
    offsetZ = (maxZ + minZ) / 2;
    console.log(`Offset: ${offsetX.toFixed()} ${offsetY.toFixed()} ${offsetZ.toFixed()}`);

    callback();
  }, 10000);
}

// Connect to IoT Hub
function connect(onMessage, callback) {
  client.open(err => {
    if (err) {
      callback(err);
    } else {
      client.on('message', msg => {
        // Tell IoT Hub we have recieved this message and remove it from the queue
        client.complete(callback);
      });
      callback();
    }
  });
}

// Send data to IoT Hub
function sendData(callback) {
  const res = getOutputData();
  const message = new Message(JSON.stringify(res));

  client.sendEvent(message, err => {
    if (err) {
      callback(err);
    } else {
      callback();
    }
  });
}

function start() {
  // Initialize offset
  getOffset(() => {
    connect(msg => {
      console.log(`Recieved message: ${msg}`);
    }, err => {
      if (err) {
        console.error(`Could not connect: ${err}`);
        process.exit(1);
      }

      setInterval(() => {
        sendData(err => {
          if (err) {
            console.warn(`Send message to IoT Hub failed: ${err.toString()}`);
          } else {
            console.log('Message sent to IoT Hub.');
          }
        });
      }, 1000);
    });
  });
}

start();
