const fs = require('fs');


function deleteFileIfExists(filepath) {
if (!filepath) return;
try {
if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
} catch (e) {
// log and ignore to not break main flow
console.warn('deleteFileIfExists warn:', e?.message);
}
}


module.exports = { deleteFileIfExists };