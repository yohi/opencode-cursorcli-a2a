const fs = require('fs');
const path = require('path');

const targetPath = path.resolve(__dirname, 'node_modules', 'cursor-agent-a2a', 'dist', 'services', 'cursorAgentService.js');

if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');

    // Check if we need to apply the patch for missing 'thinking' event forwards
    if (content.includes("else if (json.type === 'assistant' && json.message?.content)") && 
        !content.includes("else if (json.type === 'thinking') {")) {
        
        console.log('[patch-cursor-agent] Patching cursor-agent-a2a to support "thinking" stream events...');
        
        const replaceTarget = `                        }
                    }`;
                    
        const replacement = `                        }
                    }
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
        
        // Find the index of the first occurrence in the assistant block to target accurately
        const index = content.indexOf("else if (json.type === 'assistant' && json.message?.content)");
        if (index !== -1) {
            const blockEndIndex = content.indexOf(replaceTarget, index);
            if (blockEndIndex !== -1) {
                content = content.slice(0, blockEndIndex) + replacement + content.slice(blockEndIndex + replaceTarget.length);
                fs.writeFileSync(targetPath, content, 'utf8');
                console.log('[patch-cursor-agent] Patch applied successfully.');
            }
        }
    } else {
        console.log('[patch-cursor-agent] Patch already applied or target code not found.');
    }
} else {
    // Optional dependency might not be installed, ignore.
    console.log('[patch-cursor-agent] cursor-agent-a2a not found, skipping patch.');
}
