import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame, type MasterFrame } from './master-protocol';
import { NA, netadr } from './net';

/** Bytes as they read: the marker as `\xff`, the rest as text. */
function text(data: Uint8Array): string {
  return String.fromCharCode(...data);
}

/** Text with the out-of-band marker in front. */
function oob(line: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(`\xff\xff\xff\xff${line}`, (c) => c.charCodeAt(0));
}

const server = netadr(NA.IP, '203.0.113.9', 27961);

describe('the frames', () => {
  it('are written as one line of text behind the marker, and a payload after it', () => {
    expect(
      text(
        encodeFrame({
          kind: 'greeting',
          address: netadr(NA.IP, '198.51.100.4', 50123),
          iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }]
        })
      )
    ).toBe(
      '\xff\xff\xff\xffgreeting 198.51.100.4:50123\n' +
        '{"iceServers":[{"urls":"stun:stun.cloudflare.com:3478"}]}'
    );
    expect(text(encodeFrame({ kind: 'register', port: 27960 }))).toBe(
      '\xff\xff\xff\xffregister 27960'
    );
    expect(text(encodeFrame({ kind: 'registerResponse', address: server }))).toBe(
      '\xff\xff\xff\xffregisterResponse 203.0.113.9:27961'
    );
    expect(
      text(encodeFrame({ kind: 'relay', peer: server, data: oob('getinfo xxx') }))
    ).toBe('\xff\xff\xff\xffrelay 203.0.113.9:27961\n\xff\xff\xff\xffgetinfo xxx');
  });

  it('carry a name to look up, and its answer, in JSON behind their line', () => {
    expect(text(encodeFrame({ kind: 'resolve', name: 'quake.test', port: 27961 }))).toBe(
      '\xff\xff\xff\xffresolve\n{"name":"quake.test","port":27961}'
    );
    const addresses = [server, netadr(NA.IP6, '2001:db8::9', 27961)];
    const answer = { name: 'quake.test', port: 27961, addresses, error: null };
    expect(text(encodeFrame({ kind: 'resolveResponse', ...answer }))).toBe(
      '\xff\xff\xff\xffresolveResponse\n{"name":"quake.test","port":27961,' +
        '"addresses":["203.0.113.9:27961","[2001:db8::9]:27961"],"error":null}'
    );
  });

  it('name no address in a signal to or from the master itself', () => {
    const signal = { dial: 3, description: { type: 'answer' as const, sdp: 'v=0\r\n' } };
    expect(text(encodeFrame({ kind: 'signal', peer: null, signal }))).toBe(
      '\xff\xff\xff\xffsignal\n{"dial":3,"description":{"type":"answer","sdp":"v=0\\r\\n"}}'
    );
    expect(decodeFrame(encodeFrame({ kind: 'signal', peer: null, signal }))).toEqual({
      kind: 'signal',
      peer: null,
      signal
    });
  });

  it('come back as they went', () => {
    const frames: MasterFrame[] = [
      {
        kind: 'greeting',
        address: server,
        iceServers: [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' }]
      },
      { kind: 'register', port: 1 },
      { kind: 'register', port: 65535 },
      { kind: 'registerResponse', address: server },
      { kind: 'resolve', name: 'a name', port: 0 },
      { kind: 'resolve', name: 'quake.test', port: 65535 },
      { kind: 'resolveResponse', name: 'quake.test', port: 1, addresses: [server], error: null },
      { kind: 'resolveResponse', name: 'x', port: 1, addresses: [], error: 'ENOTFOUND' },
      {
        kind: 'signal',
        peer: server,
        signal: {
          dial: 7,
          candidate: {
            candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0,
            usernameFragment: 'abcd'
          }
        }
      },
      { kind: 'signal', peer: server, signal: { dial: 1, description: { type: 'offer', sdp: '' } } }
    ];
    for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('name an IPv6 peer in brackets, and read it back in its one spelling', () => {
    const peer = netadr(NA.IP6, '2001:db8::9', 27961);
    const data = oob('getinfo xxx');
    expect(text(encodeFrame({ kind: 'relay', peer, data }))).toBe(
      '\xff\xff\xff\xffrelay [2001:db8::9]:27961\n\xff\xff\xff\xffgetinfo xxx'
    );
    expect(decodeFrame(encodeFrame({ kind: 'registerResponse', address: peer }))).toEqual({
      kind: 'registerResponse',
      address: peer
    });
    expect(decodeFrame(oob('registerResponse [2001:DB8:0::9]:27961'))).toEqual({
      kind: 'registerResponse',
      address: peer
    });
  });

  it('carry a relayed datagram byte for byte, newlines and all', () => {
    const data = Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x0a, 0x00, 0x80, 0xfe, 0x0a);
    expect(decodeFrame(encodeFrame({ kind: 'relay', peer: server, data }))).toEqual({
      kind: 'relay',
      peer: server,
      data
    });
  });

  it('take anything else behind the marker for a datagram of dpmaster’s', () => {
    // A getserversResponse: binary entries, a newline byte among them.
    const response = Uint8Array.of(
      ...oob('getserversResponse'),
      0x5c,
      203,
      0,
      113,
      10,
      0x6d,
      0x38,
      ...Uint8Array.from('\\EOT\0\0\0', (c) => c.charCodeAt(0))
    );
    expect(decodeFrame(response)).toEqual({ kind: 'datagram', data: response });
    expect(encodeFrame({ kind: 'datagram', data: response })).toEqual(response);
    expect(decodeFrame(oob('heartbeat DarkPlaces\n'))).toEqual({
      kind: 'datagram',
      data: oob('heartbeat DarkPlaces\n')
    });
  });

  it('are refused when not out of band, or malformed', () => {
    const bad = [
      Uint8Array.of(1, 0, 0, 0, 0x67),
      Uint8Array.of(0xff, 0xff, 0xff),
      oob('register'),
      oob('register 0'),
      oob('register 65536'),
      oob('register 27960x'),
      oob('registerResponse 203.0.113.9'),
      oob('registerResponse :27960'),
      oob('registerResponse 203.0.113.9:70000'),
      oob('greeting 203.0.113.9:1\n{"iceServers":"stun:x"}'),
      oob('greeting 203.0.113.9:1\n{"iceServers":[{"urls":3}]}'),
      oob('greeting 203.0.113.9:1'),
      oob('signal 203.0.113.9:1\nnot json'),
      oob('signal 203.0.113.9\n{"dial":1,"candidate":{"candidate":""}}'),
      oob('signal\n{"candidate":{"candidate":""}}'),
      oob('signal\n{"dial":1.5,"candidate":{"candidate":""}}'),
      oob('signal\n{"dial":1}'),
      oob(
        'signal\n{"dial":1,"candidate":{"candidate":""},"description":{"type":"offer","sdp":""}}'
      ),
      oob('signal\n{"dial":1,"description":{"type":"rollback","sdp":""}}'),
      oob('signal\n{"dial":1,"description":{"type":"offer"}}'),
      oob('signal\n{"dial":1,"candidate":{"sdpMid":"0"}}'),
      oob('relay 203.0.113.9:1'),
      oob('relay nowhere\n\xff\xff\xff\xffgetinfo'),
      oob('relay 2001:db8::9:27961\n\xff\xff\xff\xffgetinfo'),
      oob('registerResponse [2001:db8::9]'),
      oob('resolve'),
      oob('resolve\n{"name":"x"}'),
      oob('resolve\n{"name":1,"port":1}'),
      oob('resolve\n{"name":"x","port":65536}'),
      oob('resolve\n{"name":"x","port":-1}'),
      oob('resolve\n{"name":"x","port":1.5}'),
      oob('resolveResponse\n{"name":"x","port":65536,"addresses":[],"error":null}'),
      oob('resolveResponse\n{"name":"x","port":1,"error":null}'),
      oob('resolveResponse\n{"name":"x","port":1,"addresses":["nowhere"],"error":null}'),
      oob('resolveResponse\n{"name":"x","port":1,"addresses":[1],"error":null}'),
      oob('resolveResponse\n{"name":"x","port":1,"addresses":[],"error":5}'),
      oob('resolveResponse\n{"name":"x","port":1,"addresses":[]}')
    ];
    for (const data of bad) expect(decodeFrame(data), text(data)).toBeNull();
  });

  it('keep a candidate to the fields a peer connection takes', () => {
    const frame = decodeFrame(oob('signal\n{"dial":2,"candidate":{"candidate":"c","extra":1}}'));
    expect(frame).toEqual({
      kind: 'signal',
      peer: null,
      signal: {
        dial: 2,
        candidate: { candidate: 'c', sdpMid: null, sdpMLineIndex: null, usernameFragment: null }
      }
    });
  });
});
