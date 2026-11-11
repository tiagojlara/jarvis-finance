// Locally persisted chat history (§10 item 4, FR-10).
//
// Lives in the assistant_* tables, which are deliberately absent from TABLE_FIELDS /
// TABLE_ORDER: no generic /api/:table route reaches them, and /api/backup does not dump
// them — a backup file is meant to be copied somewhere else, and a transcript of financial
// questions is not.
//
// Deleting a conversation deletes its messages and nothing else. There is no foreign key
// from these tables into the finance schema and no code path here that touches it, so
// deleting history can never remove a committed financial record (FR-10).

const { AssistantInputError } = require('./errors');

const MAX_TITLE_LENGTH = 80;
// How much recent history is replayed into the model. Older turns stay in the database and
// remain readable in the UI; they just are not resent, which keeps the context bounded.
const MAX_CONTEXT_MESSAGES = 30;

function deriveTitle(text) {
  const firstLine = String(text || '').trim().split(/\r?\n/)[0] || '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'New chat';
  return collapsed.length > MAX_TITLE_LENGTH ? `${collapsed.slice(0, MAX_TITLE_LENGTH - 1)}…` : collapsed;
}

function parseActivity(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// SQLite's CURRENT_TIMESTAMP writes 'YYYY-MM-DD HH:MM:SS' in UTC with a space, which
// `new Date(...)` would read as local time — an answer would look hours older or newer than
// it is. Normalise to an explicit ISO instant at the boundary the browser sees.
function toIso(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.includes('T')) return text;
  return `${text.replace(' ', 'T')}Z`;
}

function messageView(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolActivity: parseActivity(row.tool_activity),
    model: row.model || '',
    error: row.error || '',
    createdAt: toIso(row.created_at),
  };
}

function createHistory(db) {
  const conversationRow = (id) => db.prepare('SELECT * FROM assistant_conversations WHERE id = ?').get(id);

  function list() {
    return db.prepare(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM assistant_messages m WHERE m.conversation_id = c.id) AS message_count,
             (SELECT COALESCE(MAX(m.created_at), c.created_at) FROM assistant_messages m WHERE m.conversation_id = c.id) AS last_message_at,
             (SELECT m.role FROM assistant_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_role
      FROM assistant_conversations c
      ORDER BY c.updated_at DESC, c.id DESC`).all()
      .map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        messageCount: row.message_count,
        lastMessageAt: toIso(row.last_message_at),
        lastRole: row.last_role || null,
      }));
  }

  function create(title = '') {
    const cleaned = String(title || '').trim();
    const info = db.prepare('INSERT INTO assistant_conversations(title) VALUES(?)').run(cleaned || 'New chat');
    return conversationRow(info.lastInsertRowid);
  }

  function get(id) {
    const conversation = conversationRow(id);
    if (!conversation) return null;
    const messages = db.prepare('SELECT * FROM assistant_messages WHERE conversation_id = ? ORDER BY id').all(id);
    return { ...conversation, createdAt: toIso(conversation.created_at), updatedAt: toIso(conversation.updated_at), messages: messages.map(messageView) };
  }

  function rename(id, title) {
    const cleaned = String(title || '').trim();
    if (!cleaned) throw new AssistantInputError('A conversation needs a title.');
    if (cleaned.length > 200) throw new AssistantInputError('That title is too long.');
    if (!conversationRow(id)) return null;
    db.prepare("UPDATE assistant_conversations SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(cleaned, id);
    return conversationRow(id);
  }

  // The conversation the next message belongs to when the UI has not picked one.
  function latest() {
    return list()[0] || null;
  }

  function touch(id) {
    db.prepare("UPDATE assistant_conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
  }

  function titleFromFirstMessage(id) {
    const conversation = conversationRow(id);
    if (!conversation || conversation.title !== 'New chat') return;
    const first = db.prepare("SELECT content FROM assistant_messages WHERE conversation_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(id);
    if (first) db.prepare('UPDATE assistant_conversations SET title = ? WHERE id = ?').run(deriveTitle(first.content), id);
  }

  function addMessage({ conversationId, role, content, toolActivity = [], model = '', error = '' }) {
    if (!['user', 'assistant'].includes(role)) throw new AssistantInputError('Unknown message role.');
    if (!conversationRow(conversationId)) throw new AssistantInputError('That conversation no longer exists.');
    const activity = Array.isArray(toolActivity) ? toolActivity : [];
    const info = db.prepare('INSERT INTO assistant_messages(conversation_id, role, content, tool_activity, model, error) VALUES(?,?,?,?,?,?)')
      .run(conversationId, role, String(content || ''), JSON.stringify(activity), String(model || ''), String(error || ''));
    touch(conversationId);
    titleFromFirstMessage(conversationId);
    return messageView(db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(info.lastInsertRowid));
  }

  // Removing one message (e.g. a pasted question the user no longer wants in context).
  // Scoped by conversation so an id from another conversation cannot be deleted by accident.
  function deleteMessage(conversationId, messageId) {
    const info = db.prepare('DELETE FROM assistant_messages WHERE id = ? AND conversation_id = ?').run(Number(messageId), Number(conversationId));
    return info.changes > 0;
  }

  // ON DELETE CASCADE on assistant_messages handles the transcript. Foreign keys are enforced
  // (see openDatabase), so this relies on the schema and nothing else.
  function remove(id) {
    const info = db.prepare('DELETE FROM assistant_conversations WHERE id = ?').run(Number(id));
    return info.changes > 0;
  }

  function removeEmpty() {
    const info = db.prepare('DELETE FROM assistant_conversations WHERE NOT EXISTS (SELECT 1 FROM assistant_messages m WHERE m.conversation_id = assistant_conversations.id)').run();
    return info.changes;
  }

  // Text of past turns, oldest first, for the model. Tool activity is intentionally not
  // replayed: re-sending old tool payloads would multiply context for no grounding value,
  // and it is data the model already summarised into the stored answer.
  function contextMessages(id, limit = MAX_CONTEXT_MESSAGES) {
    const rows = db.prepare('SELECT role, content FROM assistant_messages WHERE conversation_id = ? AND error = \'\' ORDER BY id DESC LIMIT ?').all(Number(id), limit).reverse();
    return rows.filter((row) => String(row.content || '').trim()).map((row) => ({ role: row.role, content: row.content }));
  }

  return {
    list, create, get, rename, touch, latest, addMessage, deleteMessage, remove, removeEmpty, contextMessages, deriveTitle,
    MAX_CONTEXT_MESSAGES,
  };
}

module.exports = { createHistory, deriveTitle, MAX_CONTEXT_MESSAGES };
