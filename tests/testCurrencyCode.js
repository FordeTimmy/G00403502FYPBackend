async function testCurrencyCodeAPI() {
    // Replace with your actual JWT token
    const userToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRpbW15Zm9yZGUwMkBnbWFpbC5jb20iLCJpYXQiOjE3NDA3NTY2ODUsImV4cCI6MTc0MDc2MDI4NX0.Dt7kwh-3do-BCCPL_hYtLWvz2dc0TzvMP090pcXxieM";

    try {
        console.log('Testing /api/send-currency-code endpoint...');
        
        const response = await fetch("http://localhost:5000/api/send-currency-code", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${userToken}`
            }
        });

        const data = await response.json();
        console.log('Response:', data);

        if (data.code) {
            console.log('Success! Currency code generated:', data.code);
        } else {
            console.log('Error: No currency code in response');
        }
    } catch (error) {
        console.error('Test failed:', error);
    }
}

// Run the test
testCurrencyCodeAPI();
