/**
 * Alarm Manager Module
 * Handles alarm checking, triggering, and persistence
 */

import { EventEmitter } from './EventEmitter.js';
import { ApiClient } from './ApiClient.js';

// Progressive alarm configuration
const ALARM_CONFIG = {
  soundDuration: 30,        // Duration for sound volume to go from 0 to 1 (seconds)
  youtubeFadeInDelay: 20,   // Delay before YouTube volume starts increasing (seconds)
  youtubeFadeDuration: 15,  // Duration for YouTube volume fade-in (seconds)
  maxDuration: 5 * 60,      // Maximum alarm duration (seconds)
  updateInterval: 100,      // Interval for updating volumes (milliseconds)
};

export class AlarmManager extends EventEmitter {
  constructor(state, apiClient) {
    super();
    this.state = state;
    this.apiClient = apiClient;
    this.lastTriggeredTime = null; // Prevent multiple triggers in same minute
    
    // Progressive alarm state
    this.alarmAudio = null;
    this.alarmInterval = null;
    this.isAlarmActive = false;
    this.alarmStartTime = null;
    this.youtubeInitialVolume = 0;
    
    // Start checking immediately every 4 seconds
    setInterval(() => this.check(), 4000);
  }

  /**
   * Load alarm settings from server
   */
  async load() {
    try {
      const data = await this.apiClient.loadAlarmSettings();
      if (data) {
        this.state.alarmTime = data.time || '08:00';
        this.state.alarmEnabled = data.enabled || false;
        console.log(`Alarm loaded: ${this.state.alarmTime} (${this.state.alarmEnabled ? 'enabled' : 'disabled'})`);
      }
    } catch (err) {
      console.warn('Could not load alarm settings, using defaults:', err);
    }
  }

  /**
   * Save alarm settings to server
   */
  async save() {
    try {
      await this.apiClient.saveAlarmSettings({
        time: this.state.alarmTime,
        enabled: this.state.alarmEnabled,
      });
    } catch (err) {
      console.error('Error saving alarm settings:', err);
    }
  }

  /**
   * Check if alarm should trigger
   */
  check() {
    if (!this.state.alarmEnabled) {
      return;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    // Check if current time matches alarm time
    if (currentTimeStr === this.state.alarmTime) {
      // Prevent triggering multiple times in the same minute
      if (this.lastTriggeredTime === currentTimeStr) {
        return;
      }

      this.lastTriggeredTime = currentTimeStr;
      this.trigger();
    } else {
      // Reset when past the alarm minute
      this.lastTriggeredTime = null;
    }
  }

  /**
   * Trigger the alarm
   */
  trigger() {
    console.log(`🔔 ALARM TRIGGERED at ${this.state.alarmTime}`);
    this.emit('triggered', {
      time: this.state.alarmTime,
      timestamp: Date.now(),
    });
  }

  /**
   * Start progressive alarm with sound and volume fade
   */
  startProgressiveAlarm(playerManager) {
    if (this.isAlarmActive) {
      return;
    }

    this.isAlarmActive = true;
    this.alarmStartTime = Date.now();
    this.youtubeInitialVolume = playerManager.youtubePlayer ? playerManager.youtubePlayer.getVolume() : 0;

    playerManager.youtubePlayer.setVolume(0);

    // Create audio element for alarm sound
    if (!this.alarmAudio) {
      this.alarmAudio = new Audio('audio/gentle-notification.wav');
      this.alarmAudio.loop = true;
      this.alarmAudio.volume = 0;
    }

    this.alarmAudio.currentTime = 0;
    this.alarmAudio.play().catch(err => console.warn('Could not play alarm sound:', err));

    // Progressive volume increase
    this.alarmInterval = setInterval(() => {
      const elapsed = (Date.now() - this.alarmStartTime) / 1000;

      if (elapsed >= ALARM_CONFIG.maxDuration) {
        this.stopProgressiveAlarm();
        return;
      }

      // Alarm sound volume increases
      if (elapsed <= ALARM_CONFIG.soundDuration) {
        const alarmVolume = Math.min(1, elapsed / ALARM_CONFIG.soundDuration);
        this.alarmAudio.volume = alarmVolume;
      }

      // YouTube volume increases (after delay)
      if (elapsed >= ALARM_CONFIG.youtubeFadeInDelay && playerManager.youtubePlayer) {
        const phaseElapsed = elapsed - ALARM_CONFIG.youtubeFadeInDelay;
        const youtubeVolume = Math.min(this.youtubeInitialVolume, (phaseElapsed / ALARM_CONFIG.youtubeFadeDuration) * this.youtubeInitialVolume);
        playerManager.youtubePlayer.setVolume(youtubeVolume);
      }
    }, ALARM_CONFIG.updateInterval);

    console.log('🔊 Progressive alarm started');
  }

  /**
   * Stop progressive alarm immediately
   */
  stopProgressiveAlarm() {
    if (!this.isAlarmActive) {
      return;
    }

    this.isAlarmActive = false;

    // Stop alarm sound
    if (this.alarmAudio) {
      this.alarmAudio.pause();
      this.alarmAudio.currentTime = 0;
      this.alarmAudio.volume = 0;
    }

    // Stop interval
    if (this.alarmInterval) {
      clearInterval(this.alarmInterval);
      this.alarmInterval = null;
    }

    console.log('🔕 Progressive alarm stopped');
  }

  /**
   * Adjust alarm time by minutes
   */
  adjustTime(minutes) {
    const [hour, minute] = this.state.alarmTime.split(':').map(Number);
    let newMinute = minute + minutes;
    let newHour = hour;

    if (newMinute >= 60) {
      newHour = (newHour + Math.floor(newMinute / 60)) % 24;
      newMinute = newMinute % 60;
    } else if (newMinute < 0) {
      newHour = (newHour - 1 + 24) % 24;
      newMinute = 60 + newMinute;
    }

    const newTime = `${String(newHour).padStart(2, '0')}:${String(newMinute).padStart(2, '0')}`;
    this.state.setAlarmTime(newTime);
    this.save().catch(() => {}); // Save to server
    this.emit('timeAdjusted', newTime);
    return newTime;
  }

  /**
   * Enable alarm
   */
  enable() {
    this.state.setAlarmEnabled(true);
    this.save().catch(() => {}); // Save to server
    this.emit('enabled');
  }

  /**
   * Disable alarm
   */
  disable() {
    this.state.setAlarmEnabled(false);
    this.save().catch(() => {}); // Save to server
    this.emit('disabled');
  }

  /**
   * Toggle alarm
   */
  toggle() {
    if (this.state.alarmEnabled) {
      this.disable();
    } else {
      this.enable();
    }
  }
}

export default AlarmManager;
