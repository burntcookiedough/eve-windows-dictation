import { mount } from 'svelte';
import SettingsSpeechFixture from './SettingsSpeechFixture.svelte';
import '../app.css';

const target = document.querySelector('#fixture-root');
if (!target) throw new Error('Settings Speech fixture target is missing');

mount(SettingsSpeechFixture, { target });
