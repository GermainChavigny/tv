/**
 * Keyboard Handler Module
 * Maps keyboard inputs to actions
 * Different mappings for Windows (safe keys) vs Debian (remote control)
 */

import { EventEmitter } from './EventEmitter.js';
import config from '../config.js';

export class KeyboardHandler extends EventEmitter {
  constructor() {
    super();
    this.setupKeyMapping();
  }

  /**
   * Setup keyboard mapping based on OS detection
   */
  setupKeyMapping() {
    if (config.os === 'linux') {
      this.setupLinuxMapping();
    } else {
      this.setupWindowsMapping();
    }
  }

  /**
   * Windows mapping - Safe keyboard keys (no system interference)
   */
  setupWindowsMapping() {
    this.playlistKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']; // Numbers
    this.alarmToggleKey = '0'; // 0
    this.powerOffKey = 'p';
    this.playPauseKey = ' '; // Spacebar
    this.brightnessIncreaseKey = 'PageUp';
    this.brightnessDecreaseKey = 'PageDown';
    this.seekForwardKey = 'ArrowRight';
    this.seekBackwardKey = 'ArrowLeft';
    this.nextKey = '*';
    this.previousKey = '/';
    this.mediaVolumeUpKey = 'z';
    this.mediaVolumeDownKey = 'a';
    this.alarmTimeUpKey = 'ArrowUp';
    this.alarmTimeDownKey = 'ArrowDown';
    console.log('✅ Windows keyboard mapping loaded (safe keys)');
  }

  /**
   * Debian/Linux mapping - Remote control media keys
   */
  setupLinuxMapping() {
    this.playlistKeys = ['&', 'é', '"', "'", '(', '-', 'è', '_', 'ç']; // 1-8
    this.alarmToggleKey = 'à'; // 0
    this.powerOffKey = 'AudioVolumeMute';
    this.playPauseKey = 'MediaPlayPause';
    this.brightnessIncreaseKey = 'PageUp';
    this.brightnessDecreaseKey = 'PageDown';
    this.seekForwardKey = 'ArrowRight';
    this.seekBackwardKey = 'ArrowLeft';
    this.nextKey = 'MediaTrackNext';
    this.previousKey = 'MediaTrackPrevious';
    this.mediaVolumeUpKey = 'AudioVolumeUp';
    this.mediaVolumeDownKey = 'AudioVolumeDown';
    this.alarmTimeUpKey = 'ArrowUp';
    this.alarmTimeDownKey = 'ArrowDown';
    console.log('✅ Debian/Linux remote mapping loaded (media keys)');
  }

  /**
   * Start listening to keyboard events
   */
  start() {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
    console.log('🎮 Keyboard handler started');
  }

  /**
   * Handle keydown events
   */
  handleKeyDown(event) {
    const key = event.key;

    // Emit generic user-interaction event for all keys
    this.emit('user-interaction');

    if (key !== this.powerOffKey) {
      this.emit('none-power-off-interaction');
    }

    // Playlist keys
    const playlistIndex = this.playlistKeys.indexOf(key);
    if (playlistIndex >= 0) {
      this.emit('playlist', playlistIndex);
      return;
    }

    // Alarm toggle
    if (key === this.alarmToggleKey) {
      this.emit('alarm-toggle');
      return;
    }

    // Power off
    if (key === this.powerOffKey) {
      this.emit('power-off');
      return;
    }

    // Volume up
    if (key === this.mediaVolumeUpKey) {
      this.emit('volume-up');
      return;
    }

    // Volume down
    if (key === this.mediaVolumeDownKey) {
      this.emit('volume-down');
      return;
    }

    // Play/Pause
    if (key === this.playPauseKey) {
      this.emit('play-pause');
      return;
    }

    // Next
    if (key === this.nextKey) {
      this.emit('next');
      return;
    }

    // Previous
    if (key === this.previousKey) {
      this.emit('previous');
      return;
    }

    // Seek forward
    if (key === this.seekForwardKey) {
      this.emit('seek', 15);
      return;
    }

    // Seek backward
    if (key === this.seekBackwardKey) {
      this.emit('seek', -15);
      return;
    }

    // Brightness increase
    if (key === this.brightnessIncreaseKey) {
      this.emit('brightness', 'increase');
      return;
    }

    // Brightness decrease
    if (key === this.brightnessDecreaseKey) {
      this.emit('brightness', 'decrease');
      return;
    }

    // Alarm time up
    if (key === this.alarmTimeUpKey) {
      this.emit('alarm-time-up');
      return;
    }

    // Alarm time down
    if (key === this.alarmTimeDownKey) {
      this.emit('alarm-time-down');
      return;
    }

    // Log unmapped keys
    console.debug(`Unmapped key: ${key}`);
  }
}

export default KeyboardHandler;
