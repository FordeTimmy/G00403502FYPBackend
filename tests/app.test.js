const request = require('supertest');
const app = require('../app');

describe('Basic Express API Tests', () => {
  test('GET /api/test should return hello message', async () => {
    const res = await request(app).get('/api/test');
    
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('message', 'Hello from the backend!');
  });

  test('POST /api/verify-token should fail with missing fields', async () => {
    const res = await request(app).post('/api/verify-token').send({});
    
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('message');
  });

  test('POST /api/login should fail without token', async () => {
    const res = await request(app).post('/api/login').send({});
    
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('message', 'No token provided');
  });
});
