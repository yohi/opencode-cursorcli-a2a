const fs = require('fs');
const path = require('path');

const targetPath = path.resolve(__dirname, 'node_modules', 'cursor-agent-a2a', 'dist', 'services', 'cursorAgentService.js');
const backupPath = `${targetPath}.bak`;

function patch() {
    if (!fs.existsSync(targetPath)) {
        console.log('[patch-cursor-agent] cursor-agent-a2a not found, skipping patch.');
        return;
    }

    try {
        let content = fs.readFileSync(targetPath, 'utf8');

        // Check if patch is already applied
        if (content.includes("else if (json.type === 'thinking') {")) {
            console.log('[patch-cursor-agent] Patch already applied.');
            return;
        }

        const assistantBlockPattern = /else if\s*\(json\.type === 'assistant' && json\.message\?\.content\)\s*\{[\s\S]*?\}\s*}/;
        const match = content.match(assistantBlockPattern);

        if (!match) {
            console.warn('[patch-cursor-agent] Target code not found. Could not find assistant message block pattern.');
            return;
        }

        const index = match.index;
        const replaceTarget = match[0];
        
        console.log('[patch-cursor-agent] Patching cursor-agent-a2a to support "thinking" stream events...');
        
        const replacement = `${replaceTarget}
                    else if (json.type === 'thinking') {
                        onEvent({
                            type: 'thinking',
                            subtype: json.subtype,
                            text: json.text,
                            sessionId,
                            timestamp,
                            data: json,
                        });
                    }`;

        // Create backup
        fs.copyFileSync(targetPath, backupPath);

        try {
            const newContent = content.slice(0, index) + replacement + content.slice(index + replaceTarget.length);
            fs.writeFileSync(targetPath, newContent, 'utf8');
            console.log('[patch-cursor-agent] Patch applied successfully.');
        } catch (writeError) {
            console.error(`[patch-cursor-agent] Failed to write patched content: ${writeError.message}`);
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, targetPath);
                console.log('[patch-cursor-agent] Restored from backup.');
            }
            throw writeError;
        }
    } catch (err) {
        console.error(`[patch-cursor-agent] Critical error during patching: ${err.message}`);
    }
}

patch();
