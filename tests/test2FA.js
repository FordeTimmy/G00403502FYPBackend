async function test2FAFlow() {
    const testEmail = "test@example.com";
    const testToken = "123456";

    try {
        console.log('🔍 Testing complete 2FA flow...');
        
        // 1. First login attempt
        const loginResponse = await fetch("http://localhost:5000/api/verify-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                firebaseToken: "your-test-token-here" 
            })
        });

        const loginData = await loginResponse.json();
        console.log('Initial login response:', loginData);

        if (loginData.twoFactorRequired) {
            console.log('2FA verification required...');
            
            // 2. Verify 2FA
            const verifyResponse = await fetch("http://localhost:5000/api/verify-2fa", {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${loginData.token}`
                },
                body: JSON.stringify({ 
                    email: testEmail,
                    token: testToken
                })
            });

            const verifyData = await verifyResponse.json();
            console.log('2FA verification result:', verifyData);

            if (verifyData.token) {
                console.log('✅ 2FA verification successful');
                return true;
            }
        }

        console.log('❌ Expected 2FA requirement');
        return false;

    } catch (error) {
        console.error('❌ Test failed:', error);
        return false;
    }
}

// Run the test
test2FAFlow();
