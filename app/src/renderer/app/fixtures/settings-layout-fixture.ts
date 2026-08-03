import { mount } from 'svelte';
import SettingsLayoutFixture from './SettingsLayoutFixture.svelte';
import '../app.css';

const target = document.querySelector('#fixture-root');
if (!target) throw new Error('Settings layout fixture target is missing');

mount(SettingsLayoutFixture, { target });
