/**
 * VoiceAnnouncer Module
 * Handles speech synthesis and audio fallback for announcements
 */

class VoiceAnnouncer {
  constructor() {
    this.synth = window.speechSynthesis;
    this.audio = new Audio();
    this.haveVoices = false;

    // Delay voice loading
    setTimeout(() => {
      this.haveVoices = this.synth.getVoices().length > 0;
      console.log('Voices available:', this.haveVoices);
    }, 1000);
  }

  /**
   * Format time into "HH:MM" string
   * @param {number} hour
   * @param {number} minute
   * @returns {string}
   */
  formatTime(hour, minute) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  /**
   * Announce a string using speech synthesis or audio fallback
   * @param {string} str - Text or filename to announce
   * @param {number} volume - Volume level (0-1)
   */
  announce(str, volume = 1) {
    if (this.synth.speaking) this.synth.cancel();

    const speech = new SpeechSynthesisUtterance(str);
    speech.voice = this.synth.getVoices().find(voice => voice.name === 'Google français');
    speech.volume = volume;

    if (this.haveVoices) {
      return this.synth.speak(speech);
    }

    // Fallback if no voices
    this.audio.src = `audio/${str}.mp3`;
    this.audio.volume = volume;
    this.audio.play();
  }

  /**
   * Announce the time using speech or audio files
   * @param {number} hour
   * @param {number} minute
   * @param {number} volume - Volume level (0-1)
   */
  announceTime(hour, minute, volume = 1) {
    if (this.haveVoices) {
      return this.announce(`${hour}:${minute < 10 ? '0' + minute : minute}`, volume);
    }

    // Fallback: play wav files
    const files = [
      `audio/numbers/${hour}.wav`,
      `audio/numbers/${minute}.wav`
    ];

    this.playAudioFilesSequentially(files, volume);
  }

  /**
   * Play multiple audio files sequentially
   * @param {string[]} files - Array of file paths
   * @param {number} volume - Volume level (0-1)
   */
  playAudioFilesSequentially(files, volume = 1) {
    if (files.length === 0) return;

    this.audio.src = files[0];
    this.audio.volume = volume;
    this.audio.play();

    this.audio.onended = () => {
      this.playAudioFilesSequentially(files.slice(1), volume);
    };
  }
}

// Export as singleton
export default new VoiceAnnouncer();
