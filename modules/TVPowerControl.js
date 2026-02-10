/**
 * TV Power Control Module
 * Manages power on/off through hardware or emulation
 */

import { EventEmitter } from './EventEmitter.js';

export class TVPowerControl extends EventEmitter {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.isOn = true;
    this.lastCommand = null;
  }

  /**
   * Turn TV on
   */
  async powerOn() {
    try {
      const result = await this.apiClient.setTvPower(true);
      this.isOn = true;
      this.lastCommand = 'on';
      this.emit('powerOn', result);
      return result;
    } catch (err) {
      console.error('Power ON failed:', err);
      this.emit('powerError', { command: 'on', error: err });
      throw err;
    }
  }

  /**
   * Turn TV off
   */
  async powerOff() {
    try {
      const result = await this.apiClient.setTvPower(false);
      this.isOn = false;
      this.lastCommand = 'off';
      this.emit('powerOff', result);
      return result;
    } catch (err) {
      console.error('Power OFF failed:', err);
      this.emit('powerError', { command: 'off', error: err });
      throw err;
    }
  }

  /**
   * Toggle power state
   */
  async toggle() {
    return this.isOn ? this.powerOff() : this.powerOn();
  }

  /**
   * Get current power state
   */
  getPowerState() {
    return this.isOn;
  }
}

export default TVPowerControl;
