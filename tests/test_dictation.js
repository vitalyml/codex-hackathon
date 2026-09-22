// node --test tests/test_dictation.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

function target() {
  const handlers = {}, classes = new Set();
  return {
    classes, textContent: '', value: '',
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    setAttribute() {},
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    emit(name, event) { for (const fn of handlers[name] || []) fn(event); },
  };
}

function dictation({ pendingKey = false } = {}) {
  const mic = target(), status = target(), rule = target(), peers = [], tracks = [];
  let grantKey;
  const key = pendingKey ? new Promise((resolve) => { grantKey = resolve; }) : Promise.resolve({ value: 'test' });
  class Peer {
    constructor() {
      Object.assign(this, target());
      this.channel = target(); this.channel.readyState = 'connecting';
      this.connectionState = 'new'; peers.push(this);
    }
    addTrack(track) { this.track = track; }
    getSenders() { return this.track ? [{ track: this.track }] : []; }
    createDataChannel() { return this.channel; }
    async createOffer() { return { sdp: 'offer' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {}
    close() { this.connectionState = 'closed'; this.emit('connectionstatechange'); }
    connect() { this.connectionState = 'connected'; this.emit('connectionstatechange'); }
    open() { this.channel.readyState = 'open'; this.channel.emit('open'); }
    event(type, fields = {}) { this.channel.emit('message', { data: JSON.stringify({ type, ...fields }) }); }
  }
  const context = {
    mic, status, rule, form: target(), addBtn: target(), subscriber: 'test',
    window: { RTCPeerConnection: Peer }, RTCPeerConnection: Peer,
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
      tracks.push(track); return { getTracks: () => [track] };
    } } },
    api: () => key,
    fetch: async () => ({ ok: true, text: async () => 'answer' }),
    say(text) { status.textContent = text; }, setTimeout() { return 1; }, clearTimeout() {},
  };
  const source = fs.readFileSync('static/app.js', 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('(function setupDictation()'), source.indexOf('\nif (!client)')), context);
  return { mic, status, rule, peers, tracks, grantKey,
    async settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); },
  };
}

for (const sessionFirst of [false, true]) {
  test(`ready requires transport, channel and server session (session first: ${sessionFirst})`, async () => {
    const p = dictation(); p.mic.emit('click'); await p.settle();
    const pc = p.peers[0];
    assert.match(p.status.textContent, /Preparing/);
    assert.equal(p.tracks[0].enabled, false);
    if (sessionFirst) pc.event('session.created'); else pc.connect();
    assert.equal(p.mic.classes.has('listening'), false);
    if (sessionFirst) pc.connect(); else pc.event('session.created');
    assert.equal(p.mic.classes.has('listening'), false);
    pc.open();
    assert.equal(p.mic.classes.has('listening'), true);
    assert.equal(p.tracks[0].enabled, true);
    assert.equal(p.status.textContent, 'Ready — speak now.');
    pc.event('conversation.item.input_audio_transcription.delta', { delta: 'first words' });
    assert.equal(p.rule.value, 'first words');
    pc.channel.emit('close');
    assert.equal(p.mic.classes.has('listening'), false);
    assert.equal(p.tracks[0].stopped, true);
  });
}

test('events from a stopped session cannot change a new dictation', async () => {
  const p = dictation(); p.mic.emit('click'); await p.settle();
  const old = p.peers[0];
  p.mic.emit('click'); p.mic.emit('click'); await p.settle();
  old.connect(); old.open(); old.event('session.created');
  old.event('conversation.item.input_audio_transcription.delta', { delta: 'stale words' });
  old.event('error', { error: { message: 'old error' } });
  assert.equal(p.rule.value, '');
  assert.match(p.status.textContent, /Preparing/);
  assert.equal(p.mic.classes.has('listening'), false);
  assert.notEqual(p.peers[1].connectionState, 'closed');
});

test('cancel while awaiting credentials stops a microphone granted later', async () => {
  const p = dictation({ pendingKey: true });
  p.mic.emit('click'); p.mic.emit('click'); await p.settle();
  assert.equal(p.tracks[0].stopped, true);
  p.grantKey({ value: 'late' }); await p.settle();
  assert.equal(p.peers[0].track, undefined);
  assert.equal(p.mic.classes.has('listening'), false);
});

test('cancel stops an acquired microphone even while credentials are pending', async () => {
  const p = dictation({ pendingKey: true });
  p.mic.emit('click'); await p.settle();
  assert.equal(p.tracks[0].stopped, false);
  p.mic.emit('click');
  assert.equal(p.tracks[0].stopped, true);
  p.grantKey({ value: 'late' }); await p.settle();
  assert.equal(p.mic.classes.has('listening'), false);
});
