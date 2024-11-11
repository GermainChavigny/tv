const setItem = localStorage.setItem;
localStorage.constructor.prototype.setItem = (key, value) => setItem.apply(localStorage, [location.pathname + ':' + key, value])

const getItem = localStorage.getItem;
localStorage.constructor.prototype.getItem = (key) => getItem.apply(localStorage, [location.pathname + ':' + key]);

const removeItem = localStorage.removeItem;
localStorage.constructor.prototype.removeItem = (key) => removeItem.apply(localStorage, [location.pathname + ':' + key]);
