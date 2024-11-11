function initSpeechRecognition() {


  const startButton = document.getElementById('startButton');
  const outputDiv = document.getElementById('output');

  const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition || window.mozSpeechRecognition || window.msSpeechRecognition)();
  recognition.lang = 'fr-FR';

  recognition.onstart = () => {
    startButton.textContent = 'Listening...';
  };

  recognition.onresult = (event) => {
    console.info(event)
    const transcript = event.results[0][0].transcript;
    outputDiv.textContent = transcript;

    var msg = new SpeechSynthesisUtterance();
    msg.text = transcript;
    window.speechSynthesis.speak(msg);
  };

  recognition.onend = () => {
    startButton.textContent = 'Start Voice Input';
  };

  startButton.addEventListener('click', () => {
    recognition.start();
  });

  document.addEventListener('keydown', function (event) {  // touche 0
    //if (event.key === 'à') recognition.start();
  })
  
}