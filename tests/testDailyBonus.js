async function testDailyBonus(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`\nTesting daily bonus (Attempt ${attempt}/${retries})...`);
            
            const response = await fetch("http://localhost:5000/api/trigger-daily-bonus", {
                method: "POST",
                headers: { "Content-Type": "application/json" }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            console.log('Response:', data);

            if (data.message === "Daily bonus job triggered successfully!") {
                console.log('Success! Daily bonus triggered');
                return true;
            }
            console.log('Unexpected response:', data);
            
        } catch (error) {
            console.error(`Attempt ${attempt} failed:`, error);
            if (attempt === retries) {
                console.error(' All attempts failed');
                return false;
            }
            // Wait 2 seconds before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// Run the test
testDailyBonus().then(success => {
    if (!success) process.exit(1);
});
