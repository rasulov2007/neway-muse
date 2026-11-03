import { describe, expect, it } from 'vitest';
import { destinationAfterLogin } from './login-destination';

describe('destinationAfterLogin', () => {
  it('returns to the page that asked for the login', () => {
    expect(destinationAfterLogin({ pathname: '/hr/recruiting', search: '' })).toBe('/hr/recruiting');
    expect(destinationAfterLogin({ pathname: '/login', search: '?next=%2Fdriver-relations' })).toBe('/driver-relations');
  });
  it('never follows another site or the login page itself', () => {
    expect(destinationAfterLogin({ pathname: '/login', search: '?next=%2F%2Fevil.example' })).toBe('/');
    expect(destinationAfterLogin({ pathname: '/login', search: '?next=https%3A%2F%2Fevil.example' })).toBe('/');
    expect(destinationAfterLogin({ pathname: '/login', search: '' })).toBe('/');
  });
});
