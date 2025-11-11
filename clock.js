const defaultAlarmTime = "08:00"; // Default alarm time if no saved time

if (!localStorage.getItem("alarmTime")) localStorage.setItem("alarmTime", defaultAlarmTime);
if (!localStorage.getItem("alarmEnabled")) localStorage.setItem("alarmEnabled", "false");


// SpeechSynthesis setup
let synth = window.speechSynthesis;
//delay voice loading
let haveVoices = false;

setTimeout(() => {
    haveVoices = synth.getVoices().length > 0;
    console.log("Voices available:", haveVoices);
}, 1000);


const audio = new Audio();

// Function to format time into "HH:MM" string
function formatTime(hour, minute) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}


function announce(str) {
    
    if (synth.speaking) synth.cancel();  // Cancel current speech if speaking

    const speech = new SpeechSynthesisUtterance(str);
    speech.voice = synth.getVoices().find(voice => voice.name === 'Google français');
    speech.volume = player.getVolume() / 100;
    if (haveVoices) return synth.speak(speech);

    //fallback if no voices
    audio.src = `audio/${str}.mp3`;
    audio.volume = player.getVolume() / 100;
    audio.play();
}

function announceTime(hour, minute) {

    if (haveVoices) return announce(`${hour}:${minute < 10 ? '0' + minute : minute}`);

    //fallback if no voices
    // play wav files
    let files = [];
    files.push(`audio/numbers/${hour}.wav`);
    files.push(`audio/numbers/${minute}.wav`);

    playAudioFilesSequentially(files);
}

function playAudioFilesSequentially(files) {
    if (files.length === 0) return;
    
    
    audio.src = files[0];
    audio.volume = player.getVolume() / 100;
    audio.play();
    
    audio.onended = function() {
        playAudioFilesSequentially(files.slice(1));
    };
}

// Function to check the current time
function checkTime() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Retrieve or initialize alarm time from localStorage
    let savedAlarmTime = localStorage.getItem("alarmTime");
    [alarmHour, alarmMinute] = savedAlarmTime.split(":").map(Number);

    //console.info(currentHour, alarmHour, currentMinute, alarmMinute, localStorage.getItem("alarmEnabled"))

    if (currentHour === alarmHour && currentMinute === alarmMinute && localStorage.getItem("alarmEnabled") === "true") {
        //if (true) {
        playPlaylistIndex(6)
    }

}

// Listen for key events to adjust the alarm time
document.addEventListener('keydown', function(event) {

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'à') return

    if (event.key === 'à') {

        if (localStorage.getItem("alarmEnabled") === "true") {
            announce("Pas de réveil")
            localStorage.setItem("alarmEnabled", "false");
            return
        }

        if (localStorage.getItem("alarmEnabled") === "false") {
            announce("Réveil activé")
            localStorage.setItem("alarmEnabled", "true");
            return
        }

    }

    if (event.key === 'ArrowUp') {
        // Increase alarm time by 10 minutes
        alarmMinute += 10;
        if (alarmMinute >= 60) {
            alarmMinute = alarmMinute % 60;
            alarmHour = (alarmHour + 1) % 24;
        }
    }

    if (event.key === 'ArrowDown') {
        // Decrease alarm time by 10 minutes
        alarmMinute -= 10;
        if (alarmMinute < 0) {
            alarmMinute = 60 + alarmMinute;
            alarmHour = (alarmHour === 0) ? 23 : alarmHour - 1;
        }
    }

    let newTime = formatTime(alarmHour, alarmMinute);
    localStorage.setItem("alarmTime", newTime); // Save updated time
    localStorage.setItem("alarmEnabled", "true");
    announceTime(alarmHour, alarmMinute);
});


//setInterval(checkTime, 1000 * 60);
setInterval(checkTime, 1000 * 4);



